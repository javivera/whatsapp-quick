require("dotenv").config({ path: process.env.DOTENV_PATH || "../.env" });

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const QRCode = require("qrcode");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const Message = require("whatsapp-web.js/src/structures/Message");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HOST = (process.env.WEBJS_BRIDGE_HOST || "127.0.0.1").trim();
const PORT = Number.parseInt(process.env.WEBJS_BRIDGE_PORT || "8787", 10) || 8787;
const HEADLESS = ((process.env.WEBJS_HEADLESS || "true").trim().toLowerCase() !== "false");
const AUTH_CLIENT_ID = (
  process.env.WEBJS_BRIDGE_AUTH_CLIENT_ID ||
  process.env.WEBJS_TERMINAL_AUTH_CLIENT_ID ||
  process.env.WEBJS_AUTH_CLIENT_ID ||
  "gui"
).trim() || "gui";
const AUTH_DATA_DIR = (
  process.env.WEBJS_AUTH_DATA_DIR ||
  path.resolve(process.cwd(), ".wwebjs_auth")
).trim();
const CHAT_CACHE_PATH = path.join(AUTH_DATA_DIR, `chat-cache-${AUTH_CLIENT_ID}.json`);
const PUPPETEER_EXECUTABLE_PATH = (
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].find((candidate) => fs.existsSync(candidate)) ||
  ""
).trim();

if (AUTH_DATA_DIR) {
  fs.mkdirSync(AUTH_DATA_DIR, { recursive: true });
}

// Background refresh interval (ms). Increase to reduce Puppeteer pressure.
const BG_REFRESH_INTERVAL_MS = 60_000;
// Maximum backoff when background refresh keeps failing.
const BG_MAX_BACKOFF_MS = 5 * 60_000;
// Timeout for any single Puppeteer operation (ms).
const PUPPETEER_OP_TIMEOUT_MS = 15_000;
// How many recent messages to keep per chat in memory.
const MESSAGES_CACHE_LIMIT = 1000;
// How many recent chats to warm on startup.
const STARTUP_PREWARM_CHAT_COUNT = Number.parseInt(
  process.env.WEBJS_STARTUP_PREWARM_CHAT_COUNT || "6",
  10,
) || 6;
const HEALTH_CONNECTION_CHECK_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  ready: false,
  status: "initializing",
  lastEventAt: Date.now(),
  myJid: "",

  // Chat list cache (array of normalized chat objects)
  chatsCache: [],
  chatsCacheAt: 0,

  // Per-chat message cache: Map<chatId, { messages: NormalizedMsg[], fetchedAt: number, chatMeta: {...} }>
  messagesCache: new Map(),
  messageFetchQueueTail: Promise.resolve(),
  messageFetchInFlight: new Map(),

  // Profile picture cache:
  // Map<chatId, { url: string|null, dataUrl: string|null, fetchedAt: number }>
  profilePicCache: new Map(),
  // Link preview cache: Map<url, { preview: object, fetchedAt: number }>
  linkPreviewCache: new Map(),
  profilePicRefreshRunning: false,

  // Background refresh bookkeeping
  bgRefreshRunning: false,
  bgConsecutiveFailures: 0,
  startupWarmupRunning: false,

  // QR auth
  latestQrText: "",
  latestQrSvg: "",
};

let shutdownPromise = null;
let authenticatedReadyWatchdogTimer = null;
let authenticatedReadyWatchdogAttempts = 0;
let readyForcedByWatchdog = false;

// ---------------------------------------------------------------------------
// WhatsApp client
// ---------------------------------------------------------------------------

const client = new Client({
  authStrategy: new LocalAuth({ clientId: AUTH_CLIENT_ID, dataPath: AUTH_DATA_DIR }),
  puppeteer: {
    headless: HEADLESS,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    ...(PUPPETEER_EXECUTABLE_PATH
      ? { executablePath: PUPPETEER_EXECUTABLE_PATH }
      : {}),
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveBinaryPath(envVarName, fallbackNames) {
  const explicit = String(process.env[envVarName] || "").trim();
  if (explicit) return explicit;

  for (const candidate of fallbackNames) {
    if (!candidate) continue;
    if (candidate.includes("/")) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    return candidate;
  }

  return fallbackNames.find(Boolean) || "";
}

/** Run an async function with a hard timeout. Rejects if it takes too long. */
function withTimeout(fn, ms, label = "operation") {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`${label} timed out after ${ms}ms`));
      }
    }, ms);

    fn().then(
      (value) => {
        if (!settled) { settled = true; clearTimeout(timer); resolve(value); }
      },
      (err) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(err); }
      },
    );
  });
}

function isTransientClientError(err) {
  const text = String(err?.message || err || "").toLowerCase();
  if (text === "r" || text === "r: r") {
    return true;
  }
  return [
    "detached frame",
    "execution context was destroyed",
    "cannot find context with specified id",
    "target closed",
    "session closed",
    "protocol error",
    "protocol timeout",
    "navigation timeout",
    "most likely because of a navigation",
    "timed out after",
  ].some((part) => text.includes(part));
}

function recoverTransientClientConnection(err, reason, context) {
  if (!isTransientClientError(err)) {
    return false;
  }

  console.warn(
    `[bridge] ${context} hit a transient client error, reconnecting: ${err?.message || err}`
  );
  triggerReconnection(reason).catch((reconnectErr) => {
    console.error(`[bridge] triggerReconnection failed after ${context}:`, reconnectErr?.message || reconnectErr);
  });
  return true;
}

/**
 * Retry an operation that may fail due to transient Puppeteer/client errors.
 * Retries up to 3 times with exponential backoff for transient errors.
 */
async function withRetry(fn, label = "operation", maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransientClientError(err)) {
        // Not a transient error, fail immediately
        throw err;
      }
      if (attempt < maxRetries) {
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        console.warn(
          `[bridge] ${label} failed (attempt ${attempt}/${maxRetries}): ${err?.message}. Retrying in ${delayMs}ms...`
        );
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

function touchStatus(status) {
  state.status = status;
  state.lastEventAt = Date.now();
}

async function probeClientConnection() {
  if (!state.ready) {
    return {
      ok: false,
      clientState: "",
      error: "client_not_ready",
      transient: false,
    };
  }

  try {
    const clientState = await withTimeout(
      () => client.getState(),
      HEALTH_CONNECTION_CHECK_TIMEOUT_MS,
      "health getState",
    );
    if (clientState !== "CONNECTED") {
      return {
        ok: false,
        clientState,
        error: `client_state:${clientState}`,
        transient: false,
      };
    }

    if (!client.pupPage) {
      return {
        ok: false,
        clientState,
        error: "puppeteer_page_missing",
        transient: true,
      };
    }

    const runtimeProbe = await withTimeout(
      () => client.pupPage.evaluate(() => {
        const store = globalThis.Store || null;
        const socket = typeof globalThis.require === "function"
          ? globalThis.require("WAWebSocketModel")?.Socket
          : null;
        const conn = store?.Conn || socket || null;
        const chatCollection = store?.Chat || null;

        let chatCount = -1;
        if (Array.isArray(chatCollection?.models)) {
          chatCount = chatCollection.models.length;
        } else if (typeof chatCollection?.getModelsArray === "function") {
          try {
            chatCount = chatCollection.getModelsArray().length;
          } catch (_) {
            chatCount = -1;
          }
        }

        return {
          readyState: document.readyState || "",
          hasStore: Boolean(store),
          hasWWebJS: Boolean(globalThis.WWebJS),
          chatCount,
          connectionState: typeof conn?.state === "string"
            ? conn.state
            : (typeof conn?.stream === "string" ? conn.stream : ""),
          locationHref: location.href || "",
        };
      }),
      HEALTH_CONNECTION_CHECK_TIMEOUT_MS,
      "health runtime probe",
    );

    if (!runtimeProbe?.hasWWebJS) {
      return {
        ok: false,
        clientState,
        error: "whatsapp_runtime_unavailable",
        transient: true,
      };
    }

    if (runtimeProbe.readyState !== "complete") {
      return {
        ok: false,
        clientState,
        error: `dom_state:${runtimeProbe.readyState || "unknown"}`,
        transient: false,
      };
    }

    // Check WhatsApp's internal websocket connection state.
    // After a long idle or sleep/wake the WS may be dead (TIMEOUT/CONFLICT)
    // while Puppeteer still appears functional.
    const BAD_WA_CONN_STATES = ["TIMEOUT", "CONFLICT", "UNLAUNCHED"];
    if (BAD_WA_CONN_STATES.includes(runtimeProbe.connectionState)) {
      return {
        ok: false,
        clientState,
        error: `wa_conn_state:${runtimeProbe.connectionState}`,
        transient: true,
      };
    }

    return {
      ok: true,
      clientState,
      error: "",
      transient: false,
    };
  } catch (err) {
    return {
      ok: false,
      clientState: "",
      error: String(err?.message || err || "connection_probe_failed"),
      transient: isTransientClientError(err),
    };
  }
}

const OUTPUT_AUDIO_MIMETYPE = "audio/mpeg";
const AUDIO_EXTENSION_BY_MIMETYPE = {
  "audio/aac": "aac",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "audio/x-m4a": "m4a",
};

const LINK_PREVIEW_TTL_MS = 30 * 60_000;
const LINK_PREVIEW_IMAGE_LIMIT_BYTES = 3 * 1024 * 1024;

function normalizeAudioMimetype(mimetype) {
  const normalized = String(mimetype || "").trim().toLowerCase();
  if (!normalized) return "";
  return normalized.split(";")[0].trim();
}

function audioFilenameForMimetype(mimetype) {
  const normalized = normalizeAudioMimetype(mimetype);
  const extension = AUDIO_EXTENSION_BY_MIMETYPE[normalized] || "bin";
  return `audio.${extension}`;
}

function transcodeAudio(audioData, args) {
  const ffmpegPath = resolveBinaryPath("FFMPEG_PATH", [
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "ffmpeg",
  ]);
  const input = Buffer.from(audioData, "base64");

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      ffmpegPath,
      ["-v", "error", "-i", "pipe:0", "-vn", "-ac", "1", ...args, "pipe:1"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    const stdout = [];
    const stderr = [];

    ffmpeg.on("error", (err) => {
      reject(new Error(`ffmpeg could not start: ${err?.message || err}`));
    });

    ffmpeg.stdout.on("data", (chunk) => stdout.push(chunk));
    ffmpeg.stderr.on("data", (chunk) => stderr.push(chunk));

    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim() || `exit code ${code}`;
        reject(new Error(`ffmpeg failed: ${detail}`));
        return;
      }

      const output = Buffer.concat(stdout);
      if (!output.length) {
        reject(new Error("ffmpeg produced empty output"));
        return;
      }

      resolve(output.toString("base64"));
    });

    ffmpeg.stdin.on("error", () => {});
    ffmpeg.stdin.end(input);
  });
}

function transcodeToMp3(audioData) {
  return transcodeAudio(audioData, [
    "-c:a", "libmp3lame",
    "-q:a", "4",
    "-f", "mp3",
  ]);
}

async function sendAudioClip(chatId, audioData, mimetype) {
  const media = new MessageMedia(mimetype, audioData, audioFilenameForMimetype(mimetype));
  return await withRetry(
    () => withTimeout(
      () => client.sendMessage(chatId, media, { waitUntilMsgSent: true }),
      PUPPETEER_OP_TIMEOUT_MS * 3,
      `sendAudio(${chatId})`,
    ),
    `sendAudio(${chatId})`,
  );
}

async function sendMediaAttachment(chatId, mediaData, mimetype, filename, caption, quotedMessageId = "") {
  const media = new MessageMedia(mimetype, mediaData, filename || "media");
  // WhatsApp Web only supports MP4 video natively; send other formats as documents
  const UNSUPPORTED_VIDEO_TYPES = ["video/webm", "video/ogg", "video/avi", "video/mkv", "video/x-matroska"];
  const options = {
    waitUntilMsgSent: true,
  };
  if (UNSUPPORTED_VIDEO_TYPES.includes(mimetype)) {
    options.sendMediaAsDocument = true;
  }
  if (caption) {
    options.caption = caption;
  }
  if (quotedMessageId) {
    options.quotedMessageId = quotedMessageId;
  }

  return await withRetry(
    () => withTimeout(
      () => client.sendMessage(chatId, media, options),
      PUPPETEER_OP_TIMEOUT_MS * 3,
      `sendMedia(${chatId})`,
    ),
    `sendMedia(${chatId})`,
  );
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalizeChat(chat) {
  const lastBody = String(chat?.lastMessage?.body || "").trim();
  const lastType = String(chat?.lastMessage?.type || "").trim() || "text";
  const lastFromMe = Boolean(chat?.lastMessage?.fromMe);
  return {
    id: chat?.id?._serialized || "",
    name: String(chat?.name || chat?.id?.user || chat?.id?._serialized || "Unknown chat"),
    is_group: Boolean(chat?.isGroup),
    archived: Boolean(chat?.archived),
    unread_count: Number(chat?.unreadCount || 0),
    timestamp: Number(chat?.timestamp || 0),
    last_message: {
      body: lastBody,
      type: lastType,
      from_me: lastFromMe,
    },
  };
}

function isHiddenSystemNotification(message) {
  const type = String(message?.type || "").trim().toLowerCase();
  const body = String(message?.body || "").trim().toLowerCase();
  return Boolean(message?.isNotification)
    || type === "e2e_notification"
    || type === "notification_template"
    || type === "notification"
    || body === "[e2e_notification]"
    || body === "[notification_template]";
}

function isFallbackChatName(name, chatId) {
  const normalizedName = String(name || "").trim();
  const normalizedId = String(chatId || "").trim();
  const idUser = normalizedId.split("@")[0];
  return !normalizedName ||
    normalizedName === normalizedId ||
    normalizedName === idUser ||
    normalizedName === "Unknown chat";
}

function loadChatsCacheFromDisk() {
  try {
    if (!fs.existsSync(CHAT_CACHE_PATH)) return;
    const payload = JSON.parse(fs.readFileSync(CHAT_CACHE_PATH, "utf8"));
    const chats = Array.isArray(payload?.chats) ? payload.chats : [];
    state.chatsCache = chats.filter((chat) => chat && typeof chat.id === "string" && chat.id);
    state.chatsCacheAt = Number(payload?.saved_at || 0);
    if (state.chatsCache.length) {
      console.log(`[bridge] Restored ${state.chatsCache.length} chats from disk cache`);
    }
  } catch (err) {
    console.warn("[bridge] Could not restore chat cache:", err?.message || err);
  }
}

const CHAT_CACHE_PERSIST_DEBOUNCE_MS = 3000;
let pendingChatsCachePersistTimer = null;
let pendingChatsCachePersistDirty = false;

function persistChatsCacheNow() {
  const temporaryPath = `${CHAT_CACHE_PATH}.${process.pid}.tmp`;
  try {
    const payload = JSON.stringify({
      version: 1,
      saved_at: Date.now(),
      chats: state.chatsCache,
    });
    fs.writeFileSync(temporaryPath, payload, "utf8");
    fs.renameSync(temporaryPath, CHAT_CACHE_PATH);
  } catch (err) {
    try { fs.unlinkSync(temporaryPath); } catch (_) {}
    console.warn("[bridge] Could not persist chat cache:", err?.message || err);
  }
}

function persistChatsCache() {
  // Coalesce bursts of synchronous cache writes (chat refresh + message
  // events can fire back-to-back) into one trailing disk write so the
  // Node event loop is not blocked on every snapshot.
  if (pendingChatsCachePersistTimer) {
    pendingChatsCachePersistDirty = true;
    return;
  }
  persistChatsCacheNow();
  pendingChatsCachePersistTimer = setTimeout(() => {
    pendingChatsCachePersistTimer = null;
    if (pendingChatsCachePersistDirty) {
      pendingChatsCachePersistDirty = false;
      persistChatsCacheNow();
    }
  }, CHAT_CACHE_PERSIST_DEBOUNCE_MS);
  if (typeof pendingChatsCachePersistTimer.unref === "function") {
    pendingChatsCachePersistTimer.unref();
  }
}

function mergeChatSnapshots(previousChats, nextChats, { preserveMissing = false } = {}) {
  const previousById = new Map(previousChats.map((chat) => [chat.id, chat]));
  const merged = nextChats.map((chat) => {
    const previous = previousById.get(chat.id);
    previousById.delete(chat.id);
    if (!previous) return chat;

    return {
      ...previous,
      ...chat,
      name: isFallbackChatName(chat.name, chat.id) && !isFallbackChatName(previous.name, previous.id)
        ? previous.name
        : chat.name,
    };
  });

  if (preserveMissing) {
    merged.push(...previousById.values());
  }

  merged.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  return merged;
}

async function resolveMissingChatNames(chats) {
  const ids = chats
    .filter((chat) => !chat.is_group && chat.id.endsWith("@lid") && isFallbackChatName(chat.name, chat.id))
    .map((chat) => chat.id);
  if (!ids.length) return;

  try {
    const resolved = await withTimeout(
      () => client.pupPage.evaluate(async (chatIds) => {
        const result = {};
        const methods = window.Store.ContactMethods;

        for (const chatId of chatIds) {
          try {
            const wid = window.Store.WidFactory.createWid(chatId);
            const phoneWid = window.Store.LidUtils?.getPhoneNumber?.(wid) || null;
            const candidates = [];

            for (const candidateWid of [wid, phoneWid]) {
              if (!candidateWid) continue;
              let contact = window.Store.Contact.get?.(candidateWid) || null;
              if (!contact && typeof window.Store.Contact.find === "function") {
                try { contact = await window.Store.Contact.find(candidateWid); } catch (_) {}
              }
              if (contact) candidates.push(contact);
            }

            for (const contact of candidates) {
              const values = [
                methods?.getName?.(contact),
                methods?.getShortName?.(contact),
                methods?.getPushname?.(contact),
                methods?.getVerifiedName?.(contact),
                contact.name,
                contact.pushname,
                contact.shortName,
              ];
              const name = values.find((value) => typeof value === "string" && value.trim());
              if (name) {
                result[chatId] = name.trim();
                break;
              }
            }
          } catch (_) {}
        }

        return result;
      }, ids),
      PUPPETEER_OP_TIMEOUT_MS,
      "resolve LID contact names",
    );

    for (const chat of chats) {
      if (resolved?.[chat.id]) chat.name = resolved[chat.id];
    }
  } catch (err) {
    console.warn("[bridge] LID contact-name resolution failed:", err?.message || err);
  }
}

loadChatsCacheFromDisk();

function pickFirstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return undefined;
}

function parseNumericValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function coerceBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on", "video"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off", "voice"].includes(normalized)) return false;
  }
  return undefined;
}

function normalizeCallStatus(rawStatus, rawData = {}) {
  if (coerceBoolean(pickFirstDefined(rawData?.isMissedCall, rawData?.missed, rawData?.wasMissed))) {
    return "missed";
  }
  if (coerceBoolean(pickFirstDefined(rawData?.isRejected, rawData?.rejected, rawData?.declined))) {
    return "rejected";
  }
  if (coerceBoolean(pickFirstDefined(rawData?.isCancelled, rawData?.isCanceled, rawData?.cancelled, rawData?.canceled))) {
    return "canceled";
  }

  const normalized = String(rawStatus || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (!normalized) {
    return undefined;
  }
  if (normalized.includes("miss")) return "missed";
  if (normalized.includes("reject") || normalized.includes("declin")) return "rejected";
  if (normalized.includes("cancel") || normalized.includes("abort")) return "canceled";
  if (normalized.includes("fail") || normalized.includes("busy") || normalized.includes("unavailable")) return "failed";
  if (
    normalized.includes("answer")
    || normalized.includes("accept")
    || normalized.includes("connect")
    || normalized.includes("complete")
  ) {
    return "completed";
  }
  return normalized;
}

function extractCallDetails(msg) {
  if (String(msg?.type || "").toLowerCase() !== "call_log") {
    return null;
  }

  const raw = msg?._data || {};
  const durationSeconds = parseNumericValue(
    pickFirstDefined(
      raw?.duration,
      raw?.callDuration,
      raw?.durationSeconds,
      raw?.callDurationSeconds,
      raw?.call_duration,
      raw?.call_duration_seconds,
      msg?.duration,
    ),
  );

  const callType = String(
    pickFirstDefined(raw?.callType, raw?.call_type, raw?.subtype, raw?.eventType) || "",
  ).trim().toLowerCase();
  const isVideo = coerceBoolean(
    pickFirstDefined(
      raw?.isVideo,
      raw?.isVideoCall,
      raw?.videoCall,
      raw?.video,
      callType === "video" ? "video" : undefined,
      callType === "voice" ? "voice" : undefined,
    ),
  );

  const rawDirection = String(
    pickFirstDefined(raw?.callDirection, raw?.direction, raw?.callSide, raw?.callOrigin) || "",
  ).trim().toLowerCase();
  let direction;
  if (["outgoing", "placed", "sent", "from_me"].includes(rawDirection)) {
    direction = "outgoing";
  } else if (["incoming", "received", "to_me"].includes(rawDirection)) {
    direction = "incoming";
  } else {
    direction = msg?.fromMe ? "outgoing" : "incoming";
  }

  const rawStatus = pickFirstDefined(
    raw?.callOutcome,
    raw?.callResult,
    raw?.callStatus,
    raw?.status,
    raw?.callOutcomeType,
    raw?.eventType,
    raw?.subtype,
  );
  const status = normalizeCallStatus(rawStatus, raw);

  let participantsCount;
  const participants = pickFirstDefined(raw?.participants, raw?.callParticipants, raw?.participantJidList);
  if (Array.isArray(participants) && participants.length) {
    participantsCount = participants.length;
  } else {
    participantsCount = parseNumericValue(pickFirstDefined(raw?.participantCount, raw?.participantsCount));
  }

  return {
    direction,
    is_video: isVideo,
    status,
    duration_seconds: durationSeconds,
    participants_count: participantsCount,
  };
}

async function loadMessageReactions(msg, { force = false } = {}) {
  if (!msg || (!force && !msg.hasReaction)) {
    return [];
  }
  if (msg._bridgeDirectStoreFallback) {
    return [];
  }

  try {
    const rawReactions = await withTimeout(
      () => msg.getReactions(),
      PUPPETEER_OP_TIMEOUT_MS,
      `getReactions(${msg?.id?._serialized})`,
    );
    if (!rawReactions) {
      return [];
    }
    return rawReactions.map((r) => ({
      emoji: r.id,
      count: r.senders.length,
      by_me: r.hasReactionByMe,
    }));
  } catch (e) {
    console.log(`[normalizeMessage] getReactions failed: ${e?.message}`);
    return [];
  }
}

async function normalizeMessage(msg, { forceLoadReactions = false } = {}) {
  const links = Array.isArray(msg?.links)
    ? msg.links
      .map((entry) => String(entry?.link || "").trim())
      .filter(Boolean)
    : [];
  const callDetails = extractCallDetails(msg);

  let quoted_msg = null;
  if (msg?.hasQuotedMsg) {
    const quotedData = msg?._data?.quotedMsg;
    const quotedBody = String(quotedData?.body || "").trim();
    const quotedType = String(quotedData?.type || "chat");

    let quotedFromMe = null;

    // 1. Try getQuotedMessage() — most reliable when the high-level API works.
    if (!msg._bridgeDirectStoreFallback) {
      try {
        const quoted = await msg.getQuotedMessage();
        quotedFromMe = Boolean(quoted?.fromMe);
        console.log(`[quote] getQuotedMessage() fromMe=${quotedFromMe}`);
      } catch (e) {
        console.log(`[quote] getQuotedMessage() failed: ${e?.message}`);
      }
    }

    // 2. Try quotedParticipant vs our own JID
    if (quotedFromMe === null) {
      const quotedParticipantValue = msg?._data?.quotedParticipant;
      const quotedParticipant = String(
        quotedParticipantValue?._serialized || quotedParticipantValue || "",
      );
      console.log(`[quote] quotedParticipant="${quotedParticipant}" myJid="${state.myJid}"`);
      if (quotedParticipant && state.myJid) {
        quotedFromMe = quotedParticipant === state.myJid;
      }
    }

    // 3. Try to look up the stanza ID in our message cache
    if (quotedFromMe === null) {
      const stanzaId = String(msg?._data?.quotedStanzaID || "");
      const chatId = String(msg?.id?.remote || msg?.from || msg?.to || "");
      console.log(`[quote] stanzaId="${stanzaId}" chatId="${chatId}"`);
      if (stanzaId && chatId) {
        const cacheEntry = state.messagesCache.get(chatId);
        if (cacheEntry) {
          const cached = cacheEntry.messages.find((m) => m.id.endsWith(`_${stanzaId}`));
          console.log(`[quote] cache lookup: ${cached ? `found fromMe=${cached.from_me}` : "not found"}`);
          if (cached) quotedFromMe = cached.from_me;
        }
      }
    }

    console.log(`[quote] final quotedFromMe=${quotedFromMe} msgFromMe=${msg?.fromMe}`);

    if (quotedData) {
      quoted_msg = {
        body: quotedBody,
        from_me: quotedFromMe ?? false,
        type: quotedType,
      };
    }
  }

  const reactions = await loadMessageReactions(msg, { force: forceLoadReactions });

  return {
    id: serializeMessageId(msg?.id),
    from_me: Boolean(msg?.fromMe),
    timestamp: Number(msg?.timestamp || 0),
    type: String(msg?.type || "text"),
    body: String(msg?.body || "").trim(),
    duration_seconds: parseNumericValue(msg?.duration),
    has_media: Boolean(msg?.hasMedia),
    title: String(msg?.title || "").trim(),
    description: String(msg?.description || "").trim(),
    links,
    call_details: callDetails,
    quoted_msg,
    reactions,
  };
}

function serializeMessageId(messageId) {
  if (!messageId) return "";
  const direct = String(messageId._serialized || messageId.$1 || "").trim();
  if (direct) return direct;

  const stanzaId = String(messageId.id || "").trim();
  const remote = String(
    messageId.remote?._serialized ||
    messageId.remote?.toString?.() ||
    messageId.remote ||
    "",
  ).trim();
  if (!stanzaId || !remote) return stanzaId;
  return `${Boolean(messageId.fromMe)}_${remote}_${stanzaId}`;
}

function upsertNormalizedMessageInCache(chatId, normalizedMessage) {
  if (!chatId || !normalizedMessage?.id) return;

  let entry = state.messagesCache.get(chatId);
  if (!entry) {
    entry = {
      messages: [],
      fetchedAt: 0,
      chatMeta: { id: chatId, name: chatId, is_group: false },
    };
    state.messagesCache.set(chatId, entry);
  }

  const existingIndex = entry.messages.findIndex((message) => message.id === normalizedMessage.id);
  if (existingIndex >= 0) {
    entry.messages[existingIndex] = normalizedMessage;
  } else {
    entry.messages.push(normalizedMessage);
  }

  entry.messages.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
  if (entry.messages.length > MESSAGES_CACHE_LIMIT) {
    entry.messages = entry.messages.slice(-MESSAGES_CACHE_LIMIT);
  }
}

function parseBool(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(value)) return true;
  if (["0", "false", "no", "n", "off"].includes(value)) return false;
  return fallback;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        if (!raw) return resolve({});
        return resolve(JSON.parse(raw));
      } catch (err) {
        return reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function extractMetaContent(html, selectors) {
  for (const selector of selectors) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["'][^>]*>`, "i"),
      new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escaped}["'][^>]*>`, "i"),
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        return decodeHtmlEntities(match[1].trim());
      }
    }
  }
  return "";
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function extractTitleTag(html) {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match?.[1] ? decodeHtmlEntities(match[1].trim()) : "";
}

function absolutizeUrl(candidate, baseUrl) {
  if (!candidate) return "";
  try {
    return new URL(candidate, baseUrl).toString();
  } catch {
    return "";
  }
}

async function fetchImageAsDataUrl(url) {
  if (!url) return "";

  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36",
      "accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "referer": url,
    },
  });
  if (!response.ok) {
    throw new Error(`image request failed with HTTP ${response.status}`);
  }

  const contentType = String(response.headers.get("content-type") || "image/jpeg").trim();
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > LINK_PREVIEW_IMAGE_LIMIT_BYTES) {
    throw new Error("preview image is too large");
  }
  const encoded = Buffer.from(arrayBuffer).toString("base64");
  return `data:${contentType};base64,${encoded}`;
}

async function resolveLinkPreview(url) {
  const cached = state.linkPreviewCache.get(url);
  if (cached && (Date.now() - cached.fetchedAt) < LINK_PREVIEW_TTL_MS) {
    return cached.preview;
  }

  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36",
      "accept": "text/html,application/xhtml+xml",
      "accept-language": "en-US,en;q=0.9",
    },
  });
  if (!response.ok) {
    throw new Error(`preview request failed with HTTP ${response.status}`);
  }

  const finalUrl = response.url || url;
  const html = await response.text();
  const title = extractMetaContent(html, ["og:title", "twitter:title"]) || extractTitleTag(html);
  const description = extractMetaContent(html, ["og:description", "twitter:description", "description"]);
  const imageUrl = absolutizeUrl(
    extractMetaContent(html, ["og:image", "twitter:image", "twitter:image:src"]),
    finalUrl,
  );

  let imageDataUrl = "";
  if (imageUrl) {
    try {
      imageDataUrl = await fetchImageAsDataUrl(imageUrl);
    } catch (error) {
      console.warn(`[bridge] link preview image fetch failed for ${url}:`, error?.message || error);
    }
  }

  const preview = {
    url: finalUrl,
    domain: (() => {
      try {
        return new URL(finalUrl).hostname.replace(/^www\./, "");
      } catch {
        return "";
      }
    })(),
    title,
    description,
    image_url: imageUrl,
    image_data_url: imageDataUrl,
  };

  state.linkPreviewCache.set(url, { preview, fetchedAt: Date.now() });
  return preview;
}

async function generateVideoPosterDataUrl(mediaData, mimetype) {
  if (!mediaData || !String(mimetype || "").toLowerCase().startsWith("video/")) {
    return null;
  }

  const ffmpegBin = resolveBinaryPath("FFMPEG_PATH", [
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "ffmpeg",
  ]);
  const inputBuffer = Buffer.from(mediaData, "base64");

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin, [
      "-hide_banner",
      "-loglevel", "error",
      "-ss", "0.15",
      "-i", "pipe:0",
      "-frames:v", "1",
      "-an",
      "-f", "image2pipe",
      "-vcodec", "mjpeg",
      "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;

    const finish = (error, value = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("ffmpeg thumbnail generation timed out"));
    }, 12_000);

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      finish(new Error(`ffmpeg failed to start: ${error?.message || error}`));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        finish(new Error(stderr || `ffmpeg exited with code ${code}`));
        return;
      }
      const imageBuffer = Buffer.concat(stdoutChunks);
      if (!imageBuffer.length) {
        finish(new Error("ffmpeg produced an empty thumbnail"));
        return;
      }
      finish(null, `data:image/jpeg;base64,${imageBuffer.toString("base64")}`);
    });

    child.stdin.on("error", () => {});
    child.stdin.end(inputBuffer);
  });
}

async function shutdownBridge(reason = "shutdown", exitCode = 0) {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    console.log(`[bridge] ${reason}, shutting down...`);

    try {
      await Promise.race([
        client.destroy(),
        sleep(5_000).then(() => {
          throw new Error("client.destroy timeout");
        }),
      ]);
    } catch (err) {
      console.warn(`[bridge] destroy during ${reason} failed:`, err?.message || err);
    }

    const browserProcess = client.pupBrowser?.process?.();
    if (browserProcess && !browserProcess.killed) {
      try {
        browserProcess.kill("SIGTERM");
      } catch (_) {}
    }

    await new Promise((resolve) => {
      server.close(() => resolve());
      setTimeout(resolve, 1_000);
    });

    process.exit(exitCode);
  })();

  return shutdownPromise;
}

// ---------------------------------------------------------------------------
// Cache: chat list
// ---------------------------------------------------------------------------

async function getLightweightChatsSnapshot() {
  return await client.pupPage.evaluate(() => {
    const chatCollection = window.Store?.Chat ||
      (typeof window.require === "function" ? window.require("WAWebCollections")?.Chat : null);
    const chats = chatCollection?.getModelsArray?.() || [];
    return chats.map((chat) => {
      const id = chat?.id?._serialized || "";
      const messages = chat?.msgs?.getModelsArray?.() || [];
      const visibleMessages = messages.filter((message) => {
        const type = String(message?.type || "").trim().toLowerCase();
        const body = String(message?.body || "").trim().toLowerCase();
        return !message?.isNotification
          && type !== "e2e_notification"
          && type !== "notification_template"
          && type !== "notification"
          && body !== "[e2e_notification]"
          && body !== "[notification_template]";
      });
      const lastMessage = visibleMessages.length
        ? visibleMessages[visibleMessages.length - 1]
        : null;
      const latestRawMessage = messages.length ? messages[messages.length - 1] : null;
      return {
        id: { _serialized: id, user: chat?.id?.user || "" },
        name: chat?.formattedTitle || "",
        isGroup: Boolean(chat?.groupMetadata || id.endsWith("@g.us")),
        archived: Boolean(chat?.archive),
        unreadCount: Number(chat?.unreadCount || 0),
        timestamp: Number(lastMessage?.t || chat?.t || 0),
        lastMessage: lastMessage ? {
          body: String(lastMessage.body || ""),
          type: String(lastMessage.type || "text"),
          // Raw Store message ids carry { fromMe, remote, id }.
          fromMe: Boolean(lastMessage?.id?.fromMe),
        } : latestRawMessage ? {
          body: String(latestRawMessage.body || ""),
          type: String(latestRawMessage.type || "text"),
          fromMe: Boolean(latestRawMessage?.id?.fromMe),
        } : null,
      };
    });
  });
}

async function getChatsCompat() {
  let standardChats = [];
  let standardError = null;
  try {
    standardChats = await withTimeout(
      () => client.getChats(),
      Math.min(8_000, PUPPETEER_OP_TIMEOUT_MS),
      "standard getChats",
    );
  } catch (err) {
    standardError = err;
  }

  let lightweightChats = [];
  try {
    lightweightChats = await getLightweightChatsSnapshot();
  } catch (err) {
    if (standardError) throw standardError;
    console.warn("[bridge] Lightweight chat snapshot failed:", err?.message || err);
  }

  if (lightweightChats.length > standardChats.length) {
    console.warn(
      `[bridge] Standard chat API returned ${standardChats.length}; using ${lightweightChats.length} raw Store chats`,
    );
    return lightweightChats;
  }
  if (standardError && !lightweightChats.length) throw standardError;
  return standardChats.length ? standardChats : lightweightChats;
}

/**
 * Refresh the chat list from Puppeteer. This is the ONLY place that calls
 * client.getChats(). It runs:
 *   1. Once on "ready"
 *   2. Periodically via the background timer
 *   3. Never from an HTTP handler
 */
async function refreshChatsFromPuppeteer() {
  const label = "refreshChatsFromPuppeteer";
  try {
    const chats = await withTimeout(
      () => getChatsCompat(),
      PUPPETEER_OP_TIMEOUT_MS,
      label,
    );

    chats.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));

    const previousChats = state.chatsCache;
    const nextChats = chats.map(normalizeChat);
    await resolveMissingChatNames(nextChats);

    const suspiciousShrink = previousChats.length >= 10 &&
      nextChats.length <= Math.floor(previousChats.length / 2);
    if (suspiciousShrink) {
      console.warn(
        `[bridge] ${label}: incomplete snapshot (${nextChats.length} after ${previousChats.length}); preserving cached chats`,
      );
    }

    state.chatsCache = mergeChatSnapshots(previousChats, nextChats, {
      preserveMissing: suspiciousShrink,
    });
    state.chatsCacheAt = Date.now();
    state.bgConsecutiveFailures = 0;
    persistChatsCache();

    const archivedCount = state.chatsCache.filter((c) => c.archived).length;
    console.log(`[bridge] ${label}: cached ${state.chatsCache.length} chats (${archivedCount} archived)`);
  } catch (err) {
    state.bgConsecutiveFailures += 1;
    console.warn(`[bridge] ${label} failed (attempt #${state.bgConsecutiveFailures}):`, err?.message || err);
    recoverTransientClientConnection(err, "refresh_chats_failed", label);
    // Don't clear existing cache – stale data is better than nothing.
  }
}

// ---------------------------------------------------------------------------
// Cache: profile pictures
// ---------------------------------------------------------------------------

const PROFILE_PIC_TTL_MS = 2 * 3600_000; // 2 hours for successful image fetches
const PROFILE_PIC_NULL_TTL_MS = 60_000; // retry null/missed lookups quickly
const PROFILE_PIC_BATCH_DELAY_MS = 600; // delay between fetches to avoid rate limits

function isFreshProfilePicCacheEntry(entry) {
  if (!entry?.fetchedAt) return false;
  const ttl = entry.url || entry.dataUrl ? PROFILE_PIC_TTL_MS : PROFILE_PIC_NULL_TTL_MS;
  return (Date.now() - entry.fetchedAt) < ttl;
}

async function fetchProfilePicUrl(chatId) {
  const directUrl = await withTimeout(
    () => client.getProfilePicUrl(chatId),
    PUPPETEER_OP_TIMEOUT_MS,
    `getProfilePicUrl(${chatId})`,
  );
  if (directUrl) return directUrl;

  try {
    const chat = await withTimeout(
      () => client.getChatById(chatId),
      PUPPETEER_OP_TIMEOUT_MS,
      `getChatById(${chatId})`,
    );
    if (chat && !chat.isGroup && typeof chat.getContact === "function") {
      const contact = await withTimeout(
        () => chat.getContact(),
        PUPPETEER_OP_TIMEOUT_MS,
        `getContact(${chatId})`,
      );
      if (contact && typeof contact.getProfilePicUrl === "function") {
        return await withTimeout(
          () => contact.getProfilePicUrl(),
          PUPPETEER_OP_TIMEOUT_MS,
          `contact.getProfilePicUrl(${chatId})`,
        );
      }
    }
  } catch (err) {
    if (!isTransientClientError(err)) {
      console.warn(`[bridge] fetchProfilePicUrl fallback failed for ${chatId}:`, err?.message || err);
    }
  }

  return null;
}

async function fetchProfilePicDataUrl(url, chatId) {
  if (!url) return null;

  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`profile image download failed for ${chatId}: HTTP ${response.status}`);
  }

  const contentType = (response.headers.get("content-type") || "image/jpeg").trim();
  const body = Buffer.from(await response.arrayBuffer()).toString("base64");
  return `data:${contentType};base64,${body}`;
}

async function fetchProfilePicThumbDataUrl(chatId) {
  try {
    const base64 = await withTimeout(
      () => client.pupPage.evaluate(async (targetChatId) => {
        const widFactory = window.Store?.WidFactory ||
          (typeof window.require === "function" ? window.require("WAWebWidFactory") : null);
        const chatWid = widFactory.createWid(targetChatId);
        const base64Data = await window.WWebJS.getProfilePicThumbToBase64(chatWid);
        return base64Data || null;
      }, chatId),
      PUPPETEER_OP_TIMEOUT_MS,
      `getProfilePicThumbToBase64(${chatId})`,
    );

    return base64 ? `data:image/jpeg;base64,${base64}` : null;
  } catch (err) {
    if (!isTransientClientError(err)) {
      console.warn(`[bridge] profile thumb fetch failed for ${chatId}:`, err?.message || err);
    }
    return null;
  }
}

async function resolveProfilePic(chatId) {
  const thumbDataUrl = await fetchProfilePicThumbDataUrl(chatId);
  if (thumbDataUrl) {
    return { url: null, dataUrl: thumbDataUrl, fetchedAt: Date.now() };
  }

  const url = await fetchProfilePicUrl(chatId);
  if (!url) {
    return { url: null, dataUrl: null, fetchedAt: Date.now() };
  }

  try {
    const dataUrl = await fetchProfilePicDataUrl(url, chatId);
    return { url, dataUrl, fetchedAt: Date.now() };
  } catch (err) {
    if (!isTransientClientError(err)) {
      console.warn(`[bridge] profile image proxy failed for ${chatId}:`, err?.message || err);
    }
    // Keep the raw URL as a fallback if download/proxying fails.
    return { url, dataUrl: null, fetchedAt: Date.now() };
  }
}

/**
 * Gradually fetch profile pictures for all cached chats.
 * Runs in the background, one chat at a time with small delays.
 */
async function refreshProfilePics() {
  if (state.profilePicRefreshRunning || !state.ready) return;
  state.profilePicRefreshRunning = true;

  try {
    for (const chat of state.chatsCache) {
      if (!state.ready) break;
      const cached = state.profilePicCache.get(chat.id);
      if (isFreshProfilePicCacheEntry(cached)) continue;

      try {
        state.profilePicCache.set(chat.id, await resolveProfilePic(chat.id));
      } catch (err) {
        const nextEntry = {
          url: null,
          dataUrl: null,
          fetchedAt: Date.now(),
        };
        // Retry transient failures soon instead of suppressing avatars for hours.
        if (isTransientClientError(err)) {
          nextEntry.fetchedAt -= (PROFILE_PIC_NULL_TTL_MS - 5_000);
        }
        state.profilePicCache.set(chat.id, nextEntry);
      }

      // Small delay to avoid hammering Puppeteer
      await sleep(PROFILE_PIC_BATCH_DELAY_MS);
    }
    console.log(`[bridge] refreshProfilePics: cached ${state.profilePicCache.size} pics`);
  } catch (err) {
    console.warn(`[bridge] refreshProfilePics error:`, err?.message || err);
  } finally {
    state.profilePicRefreshRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Cache: per-chat messages
// ---------------------------------------------------------------------------

async function fetchMessagesCompat(chat, chatId, limit) {
  if (typeof chat?.fetchMessages === "function") {
    try {
      return await chat.fetchMessages({ limit });
    } catch (err) {
      const text = String(err?.message || err || "").trim().toLowerCase();
      if (text !== "r" && text !== "r: r") throw err;

      console.warn(
        `[bridge] fetchMessages(${chatId}) hit the WhatsApp Web loadEarlierMsgs compatibility error; using direct Store fallback`,
      );
    }
  }

  const messageModels = await client.pupPage.evaluate(async (chatId, messageLimit) => {
    const collections = typeof window.require === "function"
      ? window.require("WAWebCollections")
      : null;
    const widFactory = window.Store?.WidFactory ||
      (typeof window.require === "function" ? window.require("WAWebWidFactory") : null);
    const chatCollection = window.Store?.Chat || collections?.Chat;
    const conversationMsgs = window.Store?.ConversationMsgs ||
      (typeof window.require === "function" ? window.require("WAWebChatLoadMessages") : null);
    const wid = widFactory.createWid(chatId);
    let chatModel = chatCollection.get?.(wid) || chatCollection.get?.(chatId) || null;
    if (!chatModel && typeof chatCollection.find === "function") {
      try { chatModel = await chatCollection.find(wid); } catch (_) {}
    }
    if (!chatModel && window.WWebJS?.getChat) {
      try { chatModel = await window.WWebJS.getChat(chatId, { getAsModel: false }); } catch (_) {}
    }
    if (!chatModel) throw new Error(`Chat not found in Store: ${chatId}`);
    const messageFilter = (message) => {
      if (message?.isNotification) return false;
      const type = String(message?.type || "").trim().toLowerCase();
      const body = String(message?.body || "").trim().toLowerCase();
      return type !== "e2e_notification"
        && type !== "notification_template"
        && type !== "notification"
        && body !== "[e2e_notification]"
        && body !== "[notification_template]";
    };
    let messages = chatModel.msgs.getModelsArray().filter(messageFilter);

    while (messages.length < messageLimit) {
      const prevMsgsCount = chatModel.msgs.length;
      let loadedMessages = null;
      try {
        const loader = typeof window.require === "function"
          ? window.require("WAWebChatLoadMessages")
          : null;
        if (typeof loader?.loadEarlierMsgs === "function") {
          loadedMessages = await loader.loadEarlierMsgs({ chat: chatModel });
        } else if (typeof conversationMsgs?.loadEarlierMsgs === "function") {
          loadedMessages = await conversationMsgs.loadEarlierMsgs({ chat: chatModel });
        }
      } catch (_) {
        try {
          if (typeof conversationMsgs?.loadEarlierMsgs === "function") {
            loadedMessages = await conversationMsgs.loadEarlierMsgs(chatModel, chatModel.msgs);
          }
        } catch (__) {
          break;
        }
      }

      messages = chatModel.msgs.getModelsArray().filter(messageFilter);
      const gotArrayProgress = Array.isArray(loadedMessages) && loadedMessages.length > 0;
      const gotStoreProgress = chatModel.msgs.length > prevMsgsCount;

      if (!gotArrayProgress && !gotStoreProgress) {
        break;
      }
    }

    messages.sort((a, b) => Number(a.t || 0) - Number(b.t || 0));
    if (messages.length > messageLimit) {
      messages = messages.slice(messages.length - messageLimit);
    }

    const serialized = [];
    for (const message of messages) {
      try {
        const model = window.WWebJS.getMessageModel(message);
        model.id = model.id || {};
        model.id._serialized = message?.id?._serialized || model.id._serialized || "";
        serialized.push(model);
      } catch (_) {}
    }
    return serialized;
  }, chatId, limit);

  return messageModels.map((message) => {
    const instance = new Message(client, message);
    instance._bridgeDirectStoreFallback = true;
    return instance;
  });
}

/**
 * Fetch message history for a chat from Puppeteer and store in cache.
 * Returns the cached entry (messages + meta). This is called:
 *   1. Lazily when a chat is opened and has no cached messages
 *   2. From the background refresh for the "active" chat (TBD)
 *   3. After sending a message
 * It acquires the puppeteerBusy lock to avoid concurrent Puppeteer calls.
 */
async function fetchMessagesFromPuppeteer(chatId, limit = MESSAGES_CACHE_LIMIT) {
  const label = `fetchMessages(${chatId})`;
  try {
    let chat = null;
    try {
      chat = await withTimeout(
        () => client.getChatById(chatId),
        Math.min(5_000, PUPPETEER_OP_TIMEOUT_MS),
        `getChatById(${chatId})`,
      );
    } catch (err) {
      const text = String(err?.message || err || "").trim().toLowerCase();
      if (text !== "r" && text !== "r: r") throw err;
      console.warn(`[bridge] getChatById(${chatId}) returned the minified \`r\` error; using Store directly`);
    }

    const rawMessages = await withTimeout(
      () => fetchMessagesCompat(chat, chatId, limit),
      PUPPETEER_OP_TIMEOUT_MS,
      label,
    );

    rawMessages.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));

    const cachedChat = state.chatsCache.find((entry) => entry.id === chatId);
    const entry = {
      messages: await Promise.all(rawMessages.map(normalizeMessage)),
      fetchedAt: Date.now(),
      reachedStart: rawMessages.length < limit,
      chatMeta: {
        id: chat?.id?._serialized || chatId,
        name: String(cachedChat?.name || chat?.name || chat?.id?.user || chatId),
        is_group: Boolean(chat?.isGroup || cachedChat?.is_group),
      },
    };
    state.messagesCache.set(chatId, entry);
    console.log(`[bridge] ${label}: cached ${entry.messages.length} messages`);
    return entry;
  } catch (err) {
    console.warn(`[bridge] ${label} failed:`, err?.message || err);
    recoverTransientClientConnection(err, `fetch_messages_failed:${chatId}`, label);
    // Return whatever is in cache, or null
    return state.messagesCache.get(chatId) || null;
  }
}

function queueMessagesFetch(chatId, limit = MESSAGES_CACHE_LIMIT, isHighPriority = false) {
  const existing = state.messageFetchInFlight.get(chatId);
  if (existing) {
    return existing;
  }

  const doFetch = () => fetchMessagesFromPuppeteer(chatId, limit);

  // If high priority (user requested this specific conversation right now),
  // execute immediately after whatever is currently running rather than waiting behind
  // all queued background prewarm tasks.
  let task;
  if (isHighPriority) {
    task = state.messageFetchQueueTail
      .catch(() => null)
      .then(doFetch)
      .finally(() => {
        state.messageFetchInFlight.delete(chatId);
      });
    state.messageFetchQueueTail = task.catch(() => null);
  } else {
    task = state.messageFetchQueueTail
      .catch(() => null)
      .then(doFetch)
      .finally(() => {
        state.messageFetchInFlight.delete(chatId);
      });
    state.messageFetchQueueTail = task.catch(() => null);
  }

  state.messageFetchInFlight.set(chatId, task);
  return task;
}

async function prewarmRecentChatsMessages(count = STARTUP_PREWARM_CHAT_COUNT) {
  if (!state.ready || state.startupWarmupRunning) return;

  const targetCount = Math.max(0, Math.min(20, Number(count) || 0));
  if (!targetCount) return;

  state.startupWarmupRunning = true;
  try {
    const candidates = state.chatsCache
      .filter((chat) => chat?.id && !chat.archived)
      .slice(0, targetCount);

    for (const chat of candidates) {
      if (!state.ready) break;
      const cached = state.messagesCache.get(chat.id);
      if (cached?.fetchedAt || state.messageFetchInFlight.has(chat.id)) {
        continue;
      }

      try {
        await queueMessagesFetch(chat.id, 80);
      } catch (err) {
        console.warn(`[bridge] startup prewarm failed for ${chat.id}:`, err?.message || err);
      }
    }

    console.log(`[bridge] startup prewarm complete for ${Math.min(candidates.length, targetCount)} chats`);
  } finally {
    state.startupWarmupRunning = false;
  }
}

/**
 * Append a single message to a chat's cache (from live events).
 */
async function appendMessageToCache(msg) {
  const chatId = msg?.from || msg?.to || "";
  if (!chatId) return;

  // Also figure out the correct cache key (whatsapp-web.js uses _serialized)
  const cacheKey = msg?.id?.remote || chatId;

  let entry = state.messagesCache.get(cacheKey);
  if (!entry) {
    entry = { messages: [], fetchedAt: 0, chatMeta: { id: cacheKey, name: "", is_group: false } };
    state.messagesCache.set(cacheKey, entry);
  }

  const normalized = await normalizeMessage(msg);

  // Deduplicate by message ID
  if (normalized.id && entry.messages.some((m) => m.id === normalized.id)) {
    return;
  }

  entry.messages.push(normalized);

  // Trim to limit
  if (entry.messages.length > MESSAGES_CACHE_LIMIT) {
    entry.messages = entry.messages.slice(-MESSAGES_CACHE_LIMIT);
  }
}

/**
 * Update chat list cache when a message event fires.
 * Instead of calling getChats() again, we just update the affected chat's
 * timestamp and last_message in place.
 *
 * NOTE: whatsapp-web.js emits BOTH "message" and "message_create" for an
 * incoming message (message_create fires for every created message,
 * incoming included). Both handlers call this function, so without
 * deduplication every incoming message would bump unread_count by 2.
 */
const SEEN_CHAT_UPDATE_IDS = new Set();
const SEEN_CHAT_UPDATE_IDS_LIMIT = 500;

function chatUpdateId(msg) {
  return String(
    msg?.id?._serialized || msg?.id?.id || msg?.id || ""
  ).trim();
}

function updateChatOnMessage(msg) {
  if (isHiddenSystemNotification(msg)) return;
  const chatId = msg?.id?.remote || msg?.from || msg?.to || "";
  if (!chatId) return;

  // Deduplicate the message/message_create double-fire (and the extra
  // updateChatOnMessage call right after our own /send). last_message /
  // timestamp are idempotent, but the unread increment is not.
  const updateId = chatUpdateId(msg);
  if (updateId) {
    if (SEEN_CHAT_UPDATE_IDS.has(updateId)) return;
    SEEN_CHAT_UPDATE_IDS.add(updateId);
    if (SEEN_CHAT_UPDATE_IDS.size > SEEN_CHAT_UPDATE_IDS_LIMIT) {
      const oldest = SEEN_CHAT_UPDATE_IDS.values().next().value;
      SEEN_CHAT_UPDATE_IDS.delete(oldest);
    }
  }

  let chat = state.chatsCache.find((c) => c.id === chatId);
  if (!chat) {
    // New contact — add it to the cache immediately so it appears in the UI
    chat = {
      id: chatId,
      name: msg?.notifyName || chatId.replace("@c.us", ""),
      timestamp: Number(msg?.timestamp || Math.floor(Date.now() / 1000)),
      unread_count: 0,
      is_group: chatId.endsWith("@g.us"),
      last_message: null,
      archived: false,
    };
    state.chatsCache.unshift(chat);
  } else {
    chat.timestamp = Number(msg?.timestamp || Math.floor(Date.now() / 1000));
  }
  chat.last_message = {
    body: String(msg?.body || "").trim(),
    type: String(msg?.type || "text"),
    from_me: Boolean(msg?.fromMe),
  };
  if (!msg?.fromMe) {
    chat.unread_count = (chat.unread_count || 0) + 1;
  }
  // Re-sort by timestamp descending
  state.chatsCache.sort((a, b) => b.timestamp - a.timestamp);
  state.chatsCacheAt = Date.now();
  persistChatsCache();
}

// ---------------------------------------------------------------------------
// Background refresh
// ---------------------------------------------------------------------------

function scheduleBackgroundRefresh(initialDelayMs = 0) {
  const backoff = Math.min(
    BG_REFRESH_INTERVAL_MS * Math.pow(1.5, state.bgConsecutiveFailures),
    BG_MAX_BACKOFF_MS,
  );
  const interval = initialDelayMs > 0
    ? initialDelayMs
    : (state.bgConsecutiveFailures > 0 ? backoff : BG_REFRESH_INTERVAL_MS);

  setTimeout(async () => {
    if (!state.ready) {
      scheduleBackgroundRefresh();
      return;
    }
    if (state.bgRefreshRunning) {
      scheduleBackgroundRefresh();
      return;
    }

    state.bgRefreshRunning = true;
    try {
      await refreshChatsFromPuppeteer();
      // Also refresh profile pics in background (non-blocking)
      refreshProfilePics().catch(() => {});
    } catch (_) {
      // Already logged inside refreshChatsFromPuppeteer
    }
    state.bgRefreshRunning = false;
    scheduleBackgroundRefresh();
  }, interval);
}

// ---------------------------------------------------------------------------
// HTTP handlers — these NEVER call Puppeteer directly (except /send)
// ---------------------------------------------------------------------------

async function handleHealth(urlObj, res) {
  const strict = parseBool(urlObj.searchParams.get("strict"), false);
  let connectionOk = state.ready;
  let clientState = "";
  let connectionError = "";

  if (strict && state.ready) {
    const probe = await probeClientConnection();
    connectionOk = probe.ok;
    clientState = probe.clientState;
    connectionError = probe.error;

    if (!probe.ok && !reconnecting) {
      triggerReconnection(`strict_health_failed:${probe.error || "unknown"}`).catch((err) => {
        console.error("[bridge] triggerReconnection from strict health failed:", err?.message || err);
      });
    }
  }

  json(res, 200, {
    success: true,
    ready: state.ready && connectionOk,
    status: state.ready && !connectionOk ? "connection_stale" : state.status,
    last_event_at: state.lastEventAt,
    chats_cached: state.chatsCache.length,
    chats_cache_age_ms: state.chatsCacheAt ? Date.now() - state.chatsCacheAt : -1,
    qr_text: state.latestQrText,
    qr_svg: state.latestQrSvg,
    connection_ok: connectionOk,
    client_state: clientState,
    connection_error: connectionError,
  });
}

async function handleChats(urlObj, res) {
  if (!state.ready) {
    // Even if not "ready", serve cache if we have any
    if (!state.chatsCache.length) {
      json(res, 503, { success: false, error: "WhatsApp client is not ready yet" });
      return;
    }
  }

  const query = String(urlObj.searchParams.get("q") || "").trim().toLowerCase();
  const includeGroups = parseBool(urlObj.searchParams.get("include_groups"), true);
  const limitRaw = Number.parseInt(urlObj.searchParams.get("limit") || "300", 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, limitRaw)) : 300;

  let chats = [...state.chatsCache];
  if (!includeGroups) chats = chats.filter((chat) => !chat.is_group);
  if (query) {
    chats = chats.filter((chat) => {
      const haystack = `${chat.name} ${chat.id}`.toLowerCase();
      return haystack.includes(query);
    });
  }
  chats = chats.slice(0, limit);

  // Attach cached profile picture URLs
  chats = chats.map((chat) => ({
    ...chat,
    profile_pic_url: state.profilePicCache.get(chat.id)?.dataUrl
      || state.profilePicCache.get(chat.id)?.url
      || null,
  }));

  json(res, 200, {
    success: true,
    chats,
    cache_age_ms: state.chatsCacheAt ? Date.now() - state.chatsCacheAt : -1,
  });
}

async function handleMessages(urlObj, res) {
  if (!state.ready) {
    json(res, 503, { success: false, error: "WhatsApp client is not ready yet" });
    return;
  }

  const chatId = String(urlObj.searchParams.get("chat_id") || "").trim();
  if (!chatId) {
    json(res, 400, { success: false, error: "chat_id is required" });
    return;
  }

  const limitRaw = Number.parseInt(urlObj.searchParams.get("limit") || "80", 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, limitRaw)) : 80;

  let entry = state.messagesCache.get(chatId);

  // For cold chats or when more history is requested than currently cached,
  // queue a background Puppeteer fetch for the requested limit.
  const needsFetch = !entry || !entry.fetchedAt || (limit > entry.messages.length && !entry.reachedStart);

  if (needsFetch) {
    queueMessagesFetch(chatId, limit, true).catch((err) => {
      console.warn(`[bridge] background message fetch failed for ${chatId}:`, err?.message || err);
    });

    const hasMessages = entry?.messages?.length > 0;
    json(res, 200, {
      success: true,
      chat: entry?.chatMeta || { id: chatId, name: chatId, is_group: false },
      messages: entry?.messages?.slice(-limit) || [],
      from_cache: Boolean(entry?.fetchedAt),
      loading: !hasMessages,
      reached_start: Boolean(entry?.reachedStart),
      cache_age_ms: entry?.fetchedAt ? Date.now() - entry.fetchedAt : -1,
    });
    return;
  }

  if (!entry) {
    json(res, 200, {
      success: true,
      chat: { id: chatId, name: chatId, is_group: false },
      messages: [],
      from_cache: false,
      reached_start: true,
    });
    return;
  }

  const messages = entry.messages.slice(-limit);
  json(res, 200, {
    success: true,
    chat: entry.chatMeta || { id: chatId, name: chatId, is_group: false },
    messages,
    from_cache: true,
    loading: false,
    reached_start: Boolean(entry.reachedStart || messages.length < limit),
    cache_age_ms: entry.fetchedAt ? Date.now() - entry.fetchedAt : -1,
  });
}

async function handleSend(req, res) {
  if (!state.ready) {
    json(res, 503, { success: false, error: "WhatsApp client is not ready yet" });
    return;
  }

  const payload = await readJsonBody(req);
  const chatId = String(payload.chat_id || "").trim();
  const text = String(payload.text || "").trim();
  const quotedMessageId = String(payload.quoted_message_id || "").trim();

  if (!chatId) {
    json(res, 400, { success: false, error: "chat_id is required" });
    return;
  }
  if (!text) {
    json(res, 400, { success: false, error: "text is required" });
    return;
  }

  try {
    // For new contacts not in the chat list, whatsapp-web.js needs the number
    // resolved via getNumberId to obtain the LID before sending.
    let resolvedChatId = chatId;
    if (chatId.endsWith("@c.us")) {
      try {
        const phone = chatId.replace("@c.us", "");
        const numberId = await withTimeout(
          () => client.getNumberId(phone),
          PUPPETEER_OP_TIMEOUT_MS,
          `getNumberId(${phone})`,
        );
        if (numberId) resolvedChatId = numberId._serialized;
      } catch (_) { /* fall back to original chatId */ }
    }

    const message = await withRetry(
      () => withTimeout(
        () => client.sendMessage(
          resolvedChatId,
          text,
          {
            // Let the GUI load previews separately so sending a URL does not
            // make WhatsApp Web fetch arbitrary remote pages synchronously.
            linkPreview: false,
            ...(quotedMessageId ? { quotedMessageId } : {}),
          },
        ),
        PUPPETEER_OP_TIMEOUT_MS,
        `sendMessage(${resolvedChatId})`,
      ),
      `sendMessage(${resolvedChatId})`,
    );

    // Immediately append to cache so the UI sees it
    appendMessageToCache(message);
    updateChatOnMessage(message);

    json(res, 200, {
      success: true,
      message: await normalizeMessage(message),
    });
  } catch (err) {
    console.error(`[bridge] sendMessage failed:`, err?.message || err);
    json(res, 500, { success: false, error: err?.message || String(err) });
  }
}

async function handleEditMessage(req, res) {
  if (!state.ready) {
    json(res, 503, { success: false, error: "WhatsApp client is not ready yet" });
    return;
  }

  const payload = await readJsonBody(req);
  const chatId = String(payload.chat_id || "").trim();
  const messageId = String(payload.message_id || "").trim();
  const text = String(payload.text || "").trim();

  if (!chatId) {
    json(res, 400, { success: false, error: "chat_id is required" });
    return;
  }
  if (!messageId) {
    json(res, 400, { success: false, error: "message_id is required" });
    return;
  }
  if (!text) {
    json(res, 400, { success: false, error: "text is required" });
    return;
  }

  try {
    const message = await withRetry(
      () => withTimeout(
        () => client.getMessageById(messageId),
        PUPPETEER_OP_TIMEOUT_MS,
        `getMessageById(${messageId})`,
      ),
      `getMessageById(${messageId})`,
    );
    if (!message) {
      json(res, 404, { success: false, error: "message not found" });
      return;
    }

    const editedMessage = await withRetry(
      () => withTimeout(
        () => message.edit(text),
        PUPPETEER_OP_TIMEOUT_MS * 2,
        `editMessage(${messageId})`,
      ),
      `editMessage(${messageId})`,
    );
    if (!editedMessage) {
      json(res, 400, { success: false, error: "message cannot be edited" });
      return;
    }

    await queueMessagesFetch(chatId, MESSAGES_CACHE_LIMIT).catch(() => null);
    refreshChatsFromPuppeteer().catch(() => {});

    json(res, 200, {
      success: true,
      message: await normalizeMessage(editedMessage),
    });
  } catch (err) {
    console.error(`[bridge] editMessage failed:`, err?.stack || err?.message || err);
    json(res, 500, { success: false, error: err?.message || String(err) });
  }
}

async function handleDeleteMessage(req, res) {
  if (!state.ready) {
    json(res, 503, { success: false, error: "WhatsApp client is not ready yet" });
    return;
  }

  const payload = await readJsonBody(req);
  const chatId = String(payload.chat_id || "").trim();
  const messageId = String(payload.message_id || "").trim();
  const everyone = Boolean(payload.everyone);

  if (!chatId) {
    json(res, 400, { success: false, error: "chat_id is required" });
    return;
  }
  if (!messageId) {
    json(res, 400, { success: false, error: "message_id is required" });
    return;
  }

  try {
    const message = await withTimeout(
      () => client.getMessageById(messageId),
      PUPPETEER_OP_TIMEOUT_MS,
      `getMessageById(${messageId})`,
    );
    if (!message) {
      json(res, 404, { success: false, error: "message not found" });
      return;
    }

    await withTimeout(
      () => message.delete(everyone, true),
      PUPPETEER_OP_TIMEOUT_MS * 2,
      `deleteMessage(${messageId})`,
    );

    await queueMessagesFetch(chatId, MESSAGES_CACHE_LIMIT).catch(() => null);
    refreshChatsFromPuppeteer().catch(() => {});

    json(res, 200, {
      success: true,
      message_id: messageId,
      deleted: true,
    });
  } catch (err) {
    console.error(`[bridge] deleteMessage failed:`, err?.stack || err?.message || err);
    json(res, 500, { success: false, error: err?.message || String(err) });
  }
}

/**
 * New endpoint: POST /refresh — triggers an on-demand background refresh
 * of the chat list. Returns immediately with cache status.
 */
async function handleRefresh(_req, res) {
  if (!state.ready) {
    json(res, 503, { success: false, error: "WhatsApp client is not ready yet" });
    return;
  }

  // Fire-and-forget a background refresh
  if (!state.bgRefreshRunning) {
    state.bgRefreshRunning = true;
    refreshChatsFromPuppeteer().finally(() => {
      state.bgRefreshRunning = false;
    });
  }

  json(res, 200, {
    success: true,
    status: "refresh_queued",
    chats_cached: state.chatsCache.length,
    cache_age_ms: state.chatsCacheAt ? Date.now() - state.chatsCacheAt : -1,
  });
}

/**
 * POST /seen — mark a chat as read (clears its unread badge).
 * Body: { chat_id: string }
 * Calls chat.sendSeen() so WhatsApp itself marks the chat read, and zeroes
 * the cached unread_count immediately so the UI updates without waiting
 * for the next background refresh.
 */
async function handleMarkSeen(req, res) {
  if (!state.ready) {
    json(res, 503, { success: false, error: "WhatsApp client is not ready yet" });
    return;
  }

  const payload = await readJsonBody(req);
  const chatId = String(payload.chat_id || "").trim();
  if (!chatId) {
    json(res, 400, { success: false, error: "chat_id is required" });
    return;
  }

  try {
    // NOTE: client.getChatById() is unusable here — its in-page getChat
    // path throws a DataError on this WA Web build. client.sendSeen()
    // goes straight to WWebJS.sendSeen and works (verified live).
    await withTimeout(
      () => client.sendSeen(chatId),
      PUPPETEER_OP_TIMEOUT_MS,
      `sendSeen(${chatId})`,
    );
    const cached = state.chatsCache.find((entry) => entry.id === chatId);
    if (cached) {
      cached.unread_count = 0;
      state.chatsCacheAt = Date.now();
      persistChatsCache();
    }
    json(res, 200, { success: true });
  } catch (err) {
    console.error(`[bridge] markSeen failed:`, err?.message || err);
    json(res, 500, { success: false, error: err?.message || String(err) });
  }
}

async function handleShutdown(_req, res) {
  json(res, 200, { success: true, status: "shutting_down" });
  setImmediate(() => {
    shutdownBridge("HTTP shutdown request").catch((err) => {
      console.error("[bridge] HTTP shutdown failed:", err?.message || err);
      process.exit(1);
    });
  });
}

/**
 * POST /delete — delete a chat.
 * Body: { chat_id: string }
 */
async function handleDelete(req, res) {
  if (!state.ready) {
    json(res, 503, { success: false, error: "WhatsApp client is not ready yet" });
    return;
  }

  const payload = await readJsonBody(req);
  const chatId = String(payload.chat_id || "").trim();
  if (!chatId) {
    json(res, 400, { success: false, error: "chat_id is required" });
    return;
  }

  try {
    const chat = await withTimeout(
      () => client.getChatById(chatId),
      PUPPETEER_OP_TIMEOUT_MS,
      `getChatById(${chatId})`,
    );
    await withTimeout(
      () => chat.delete(),
      PUPPETEER_OP_TIMEOUT_MS,
      `deleteChat(${chatId})`,
    );

    // Remove from cache
    state.chatsCache = state.chatsCache.filter((c) => c.id !== chatId);
    state.messagesCache.delete(chatId);
    state.chatsCacheAt = Date.now();
    persistChatsCache();

    console.log(`[bridge] Deleted chat: ${chatId}`);
    json(res, 200, { success: true, chat_id: chatId });
  } catch (err) {
    console.error(`[bridge] deleteChat failed:`, err?.message || err);
    json(res, 500, { success: false, error: err?.message || String(err) });
  }
}

/**
 * POST /archive — archive a chat.
 * Body: { chat_id: string }
 */
async function handleArchive(req, res) {
  if (!state.ready) {
    json(res, 503, { success: false, error: "WhatsApp client is not ready yet" });
    return;
  }

  const payload = await readJsonBody(req);
  const chatId = String(payload.chat_id || "").trim();
  if (!chatId) {
    json(res, 400, { success: false, error: "chat_id is required" });
    return;
  }

  try {
    const chat = await withTimeout(
      () => client.getChatById(chatId),
      PUPPETEER_OP_TIMEOUT_MS,
      `getChatById(${chatId})`,
    );
    await withTimeout(
      () => chat.archive(),
      PUPPETEER_OP_TIMEOUT_MS,
      `archiveChat(${chatId})`,
    );

    // Update cache in place
    const cached = state.chatsCache.find((c) => c.id === chatId);
    if (cached) cached.archived = true;
    state.chatsCacheAt = Date.now();
    persistChatsCache();

    console.log(`[bridge] Archived chat: ${chatId}`);
    json(res, 200, { success: true, chat_id: chatId, archived: true });
  } catch (err) {
    console.error(`[bridge] archiveChat failed:`, err?.message || err);
    json(res, 500, { success: false, error: err?.message || String(err) });
  }
}

/**
 * POST /unarchive — unarchive a chat.
 * Body: { chat_id: string }
 */
async function handleUnarchive(req, res) {
  if (!state.ready) {
    json(res, 503, { success: false, error: "WhatsApp client is not ready yet" });
    return;
  }

  const payload = await readJsonBody(req);
  const chatId = String(payload.chat_id || "").trim();
  if (!chatId) {
    json(res, 400, { success: false, error: "chat_id is required" });
    return;
  }

  try {
    const chat = await withTimeout(
      () => client.getChatById(chatId),
      PUPPETEER_OP_TIMEOUT_MS,
      `getChatById(${chatId})`,
    );
    await withTimeout(
      () => chat.unarchive(),
      PUPPETEER_OP_TIMEOUT_MS,
      `unarchiveChat(${chatId})`,
    );

    // Update cache in place
    const cached = state.chatsCache.find((c) => c.id === chatId);
    if (cached) cached.archived = false;
    state.chatsCacheAt = Date.now();
    persistChatsCache();

    console.log(`[bridge] Unarchived chat: ${chatId}`);
    json(res, 200, { success: true, chat_id: chatId, archived: false });
  } catch (err) {
    console.error(`[bridge] unarchiveChat failed:`, err?.message || err);
    json(res, 500, { success: false, error: err?.message || String(err) });
  }
}

/**
 * POST /send-audio — send a recorded audio clip to a chat.
 * Body: { chat_id: string, audio_data: string (base64), mimetype: string }
 */
async function handleSendAudio(req, res) {
  if (!state.ready) {
    json(res, 503, { success: false, error: "WhatsApp client is not ready yet" });
    return;
  }

  const payload = await readJsonBody(req);
  const chatId = String(payload.chat_id || "").trim();
  const audioData = String(payload.audio_data || "").trim();
  const requestedMimetype = String(payload.mimetype || "audio/ogg; codecs=opus").trim();
  const normalizedMimetype = normalizeAudioMimetype(requestedMimetype);

  if (!chatId) {
    json(res, 400, { success: false, error: "chat_id is required" });
    return;
  }
  if (!audioData) {
    json(res, 400, { success: false, error: "audio_data (base64) is required" });
    return;
  }

  try {
    const encodedAudio = normalizedMimetype === OUTPUT_AUDIO_MIMETYPE
      ? audioData
      : await transcodeToMp3(audioData);
    const message = await sendAudioClip(chatId, encodedAudio, OUTPUT_AUDIO_MIMETYPE);

    // Immediately append to cache so the UI sees it
    appendMessageToCache(message);
    updateChatOnMessage(message);

    json(res, 200, {
      success: true,
      message: await normalizeMessage(message),
    });
  } catch (err) {
    console.error(
      `[bridge] sendAudio failed (requested=${requestedMimetype}, normalized=${normalizedMimetype || "unknown"}, output=${OUTPUT_AUDIO_MIMETYPE}):`,
      err?.stack || err?.message || err,
    );
    json(res, 500, { success: false, error: err?.message || String(err) });
  }
}

/**
 * POST /send-image — send an image to a chat.
 * Body: { chat_id: string, image_data: string (base64), mimetype: string, filename?: string, caption?: string }
 */
async function handleSendImage(req, res) {
  return handleSendMedia(req, res, { imageOnly: true });
}

/**
 * POST /send-media — send an image or video to a chat.
 * Body: { chat_id: string, media_data: string (base64), mimetype: string, filename?: string, caption?: string }
 */
async function handleSendMedia(req, res, { imageOnly = false } = {}) {
  if (!state.ready) {
    json(res, 503, { success: false, error: "WhatsApp client is not ready yet" });
    return;
  }

  const payload = await readJsonBody(req);
  const chatId = String(payload.chat_id || "").trim();
  const mediaData = String(payload.media_data || payload.image_data || "").trim();
  const mimetype = String(payload.mimetype || "").trim().toLowerCase();
  const filename = String(payload.filename || "media").trim() || "media";
  const caption = String(payload.caption || "").trim();
  const quotedMessageId = String(payload.quoted_message_id || "").trim();

  if (!chatId) {
    json(res, 400, { success: false, error: "chat_id is required" });
    return;
  }
  if (!mediaData) {
    json(res, 400, { success: false, error: "media_data (base64) is required" });
    return;
  }
  const supported = mimetype.startsWith("image/") || (!imageOnly && mimetype.startsWith("video/"));
  if (!supported) {
    json(res, 400, { success: false, error: imageOnly ? "mimetype must be an image type" : "mimetype must be an image or video type" });
    return;
  }

  try {
    const message = await sendMediaAttachment(chatId, mediaData, mimetype, filename, caption, quotedMessageId);

    appendMessageToCache(message);
    updateChatOnMessage(message);

    json(res, 200, {
      success: true,
      message: await normalizeMessage(message),
    });
  } catch (err) {
    console.error(`[bridge] sendMedia failed:`, err?.stack || err?.message || err);
    json(res, 500, { success: false, error: err?.message || String(err) });
  }
}

/**
 * POST /forward — forward an existing message to another chat.
 * Body: { source_chat_id: string, message_id: string, target_chat_id: string }
 */
async function handleForward(req, res) {
  if (!state.ready) {
    json(res, 503, { success: false, error: "WhatsApp client is not ready yet" });
    return;
  }

  const payload = await readJsonBody(req);
  const sourceChatId = String(payload.source_chat_id || "").trim();
  const messageId = String(payload.message_id || "").trim();
  const targetChatId = String(payload.target_chat_id || "").trim();

  if (!sourceChatId) {
    json(res, 400, { success: false, error: "source_chat_id is required" });
    return;
  }
  if (!messageId) {
    json(res, 400, { success: false, error: "message_id is required" });
    return;
  }
  if (!targetChatId) {
    json(res, 400, { success: false, error: "target_chat_id is required" });
    return;
  }

  try {
    const sourceChat = await withTimeout(
      () => client.getChatById(sourceChatId),
      PUPPETEER_OP_TIMEOUT_MS,
      `getChatById(${sourceChatId})`,
    );
    const sourceMessages = await withTimeout(
      () => fetchMessagesCompat(sourceChat, sourceChatId, MESSAGES_CACHE_LIMIT),
      PUPPETEER_OP_TIMEOUT_MS,
      `fetchMessages(${sourceChatId})`,
    );

    const message = sourceMessages.find((entry) => entry?.id?._serialized === messageId);
    if (!message) {
      json(res, 404, { success: false, error: "Message not found" });
      return;
    }

    await withTimeout(
      () => message.forward(targetChatId),
      PUPPETEER_OP_TIMEOUT_MS * 2,
      `forwardMessage(${messageId} -> ${targetChatId})`,
    );

    const targetChat = await withTimeout(
      () => client.getChatById(targetChatId),
      PUPPETEER_OP_TIMEOUT_MS,
      `getChatById(${targetChatId})`,
    );

    const cachedChat = state.chatsCache.find((entry) => entry.id === targetChatId);
    if (cachedChat) {
      cachedChat.timestamp = Math.floor(Date.now() / 1000);
      cachedChat.last_message = {
        body: String(message.body || "").trim(),
        type: String(message.type || "text"),
        from_me: true,
      };
      state.chatsCache.sort((a, b) => b.timestamp - a.timestamp);
      state.chatsCacheAt = Date.now();
    }

    try {
      await queueMessagesFetch(targetChatId, MESSAGES_CACHE_LIMIT);
    } catch (refreshError) {
      console.warn(`[bridge] target cache refresh after forward failed for ${targetChatId}:`, refreshError?.message || refreshError);
    }

    json(res, 200, {
      success: true,
      forwarded_message: await normalizeMessage(message),
      target_chat: normalizeChat(targetChat),
    });
  } catch (err) {
    console.error(`[bridge] forward failed:`, err?.stack || err?.message || err);
    json(res, 500, { success: false, error: err?.message || String(err) });
  }
}

/**
 * GET /profile-pic — get profile picture URL for a chat/contact.
 * Query: ?chat_id=X
 * Returns cached URL or fetches on-demand.
 */
async function handleProfilePic(urlObj, res) {
  const chatId = String(urlObj.searchParams.get("chat_id") || "").trim();
  if (!chatId) {
    json(res, 400, { success: false, error: "chat_id is required" });
    return;
  }

  // Check cache first
  const cached = state.profilePicCache.get(chatId);
  if (isFreshProfilePicCacheEntry(cached)) {
    json(res, 200, { success: true, url: cached.dataUrl || cached.url });
    return;
  }

  if (!state.ready) {
    json(res, 200, { success: true, url: cached?.url || null });
    return;
  }

  // Fetch on-demand
  try {
    const resolved = await resolveProfilePic(chatId);
    state.profilePicCache.set(chatId, resolved);
    json(res, 200, { success: true, url: resolved.dataUrl || resolved.url || null });
  } catch (err) {
    const nextEntry = {
      url: null,
      dataUrl: null,
      fetchedAt: Date.now(),
    };
    if (isTransientClientError(err)) {
      nextEntry.fetchedAt -= (PROFILE_PIC_NULL_TTL_MS - 5_000);
    }
    state.profilePicCache.set(chatId, nextEntry);
    json(res, 200, { success: true, url: null });
  }
}

async function handleLinkPreview(urlObj, res) {
  const rawUrl = String(urlObj.searchParams.get("url") || "").trim();
  if (!rawUrl) {
    json(res, 400, { success: false, error: "url is required" });
    return;
  }

  let normalizedUrl = rawUrl;
  try {
    const parsed = new URL(rawUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("unsupported protocol");
    }
    normalizedUrl = parsed.toString();
  } catch {
    json(res, 400, { success: false, error: "url must be a valid http(s) URL" });
    return;
  }

  try {
    const preview = await resolveLinkPreview(normalizedUrl);
    json(res, 200, { success: true, preview });
  } catch (err) {
    console.warn(`[bridge] link preview failed for ${normalizedUrl}:`, err?.message || err);
    json(res, 500, { success: false, error: err?.message || String(err) });
  }
}

/**
 * GET /media — download media from a message.
 * Query: ?message_id=X&chat_id=Y
 * Returns { success, data (base64), mimetype, filename }
 */
/**
 * Download media with retries for transient failures.
 *
 * Freshly sent/uploaded media is often not downloadable for a short window
 * after the message appears (WhatsApp Web throws its minified single-letter
 * errors such as "t", or reports mediaStage != RESOLVED while the CDN copy
 * propagates). Without retries the UI marks the thumbnail as permanently
 * failed. Deterministic errors (message not found / no media) are not retried.
 */
const MEDIA_DOWNLOAD_MAX_ATTEMPTS = 3;
const MEDIA_DOWNLOAD_ATTEMPT_TIMEOUT_MS = 28_000;
const MEDIA_DOWNLOAD_RETRY_DELAY_MS = 1_500;

function isRetryableMediaError(err) {
  if (!err) return true;
  const text = String(err?.message || err || "").trim();
  // Minified WhatsApp Web errors (single letters like "t"/"r") are transient.
  if (/^[a-zA-Z](: [a-zA-Z])?$/.test(text)) return true;
  return isTransientClientError(err);
}

async function downloadMediaWithRetry(chatId, messageId) {
  let lastResult = null;
  let lastError = null;

  for (let attempt = 1; attempt <= MEDIA_DOWNLOAD_MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await withTimeout(
        () => downloadMediaDirectFromStore(chatId, messageId),
        MEDIA_DOWNLOAD_ATTEMPT_TIMEOUT_MS,
        `downloadMedia(${messageId}) attempt ${attempt}`,
      );

      if (result && !result.error) {
        if (attempt > 1) {
          console.log(`[bridge] downloadMedia(${messageId}) succeeded on attempt ${attempt}`);
        }
        return result;
      }

      // Deterministic failures: no point retrying.
      if (result?.error === "message_not_found" || result?.error === "no_media") {
        return result;
      }

      // Expired media (WhatsApp shows the "download" tap-to-retry state) never
      // heals by waiting — fail fast instead of hanging the caller.
      if (result?.error === "media_unavailable" && result?.stage === "REUPLOADING") {
        return result;
      }

      lastResult = result;
      console.warn(
        `[bridge] downloadMedia(${messageId}) attempt ${attempt}/${MEDIA_DOWNLOAD_MAX_ATTEMPTS} not ready: ${result?.error || "unknown"}` +
        (result?.stage ? ` (stage=${result.stage})` : "") +
        (result?.hasDirectPath === false ? " (no directPath)" : ""),
      );
    } catch (err) {
      lastError = err;
      if (!isRetryableMediaError(err) || attempt >= MEDIA_DOWNLOAD_MAX_ATTEMPTS) {
        throw err;
      }
      console.warn(
        `[bridge] downloadMedia(${messageId}) attempt ${attempt}/${MEDIA_DOWNLOAD_MAX_ATTEMPTS} threw transient error, retrying: ${err?.message || err}`,
      );
    }

    if (attempt < MEDIA_DOWNLOAD_MAX_ATTEMPTS) {
      await sleep(MEDIA_DOWNLOAD_RETRY_DELAY_MS);
    }
  }

  if (lastResult) return lastResult;
  throw lastError || new Error("Failed to download media");
}

async function handleMedia(urlObj, res) {
  if (!state.ready) {
    json(res, 503, { success: false, error: "WhatsApp client is not ready yet" });
    return;
  }

  const messageId = String(urlObj.searchParams.get("message_id") || "").trim();
  const chatId = String(urlObj.searchParams.get("chat_id") || "").trim();

  if (!messageId || !chatId) {
    json(res, 400, { success: false, error: "message_id and chat_id are required" });
    return;
  }

  try {
    const media = await downloadMediaWithRetry(chatId, messageId);

    if (media?.error === "message_not_found") {
      json(res, 404, { success: false, error: "Message not found" });
      return;
    }
    if (media?.error === "no_media") {
      json(res, 400, { success: false, error: "Message has no media" });
      return;
    }

    if (!media || media.error) {
      const transient = media?.error === "media_unavailable";
      json(res, transient ? 503 : 500, {
        success: false,
        error: transient ? "Media is not available yet, try again shortly" : "Failed to download media",
        code: media?.error || "unknown",
      });
      return;
    }

    let posterDataUrl = null;
    if (String(media.mimetype || "").toLowerCase().startsWith("video/")) {
      try {
        posterDataUrl = await generateVideoPosterDataUrl(media.data, media.mimetype);
      } catch (posterError) {
        console.warn(`[bridge] video poster generation failed for ${messageId}:`, posterError?.message || posterError);
      }
    }

    json(res, 200, {
      success: true,
      data: media.data,
      mimetype: media.mimetype || "application/octet-stream",
      filename: media.filename || "",
      poster_data_url: posterDataUrl,
    });
  } catch (err) {
    console.error(`[bridge] downloadMedia failed:`, err?.message || err);
    json(res, 500, { success: false, error: err?.message || String(err) });
  }
}

async function downloadMediaDirectFromStore(chatId, messageId) {
  return await client.pupPage.evaluate(async (targetChatId, targetMessageId) => {
    const serializedMessageId = (id) => {
      if (!id) return "";
      if (id._serialized || id.$1) return String(id._serialized || id.$1);
      const remote = id.remote?._serialized || id.remote?.toString?.() || id.remote || "";
      return id.id && remote ? `${Boolean(id.fromMe)}_${remote}_${id.id}` : String(id.id || "");
    };

    const stanzaId = targetMessageId.split("_").pop() || "";
    const collections = typeof window.require === "function"
      ? window.require("WAWebCollections")
      : null;
    const widFactory = window.Store?.WidFactory ||
      (typeof window.require === "function" ? window.require("WAWebWidFactory") : null);
    const chatCollection = window.Store?.Chat || collections?.Chat;
    const messageCollection = window.Store?.Msg || collections?.Msg;
    const chatWid = widFactory.createWid(targetChatId);
    let chat = chatCollection.get?.(chatWid) || chatCollection.get?.(targetChatId) || null;
    if (!chat && typeof chatCollection.find === "function") {
      try { chat = await chatCollection.find(chatWid); } catch (_) {}
    }

    const chatMessages = chat?.msgs?.getModelsArray?.() || [];
    let message = chatMessages.find((entry) => (
      serializedMessageId(entry?.id) === targetMessageId ||
      String(entry?.id?.id || "") === stanzaId
    ));

    if (!message) {
      try {
        message = messageCollection.get?.(targetMessageId)
          || (await messageCollection.getMessagesById?.([targetMessageId]))?.messages?.[0]
          || null;
      } catch (_) {}
    }
    if (!message) return { error: "message_not_found" };

    const hasMedia = Boolean(message.directPath || message.mediaKey || message.mediaData);
    if (!hasMedia) return { error: "no_media" };

    const mediaStage = message.mediaData?.mediaStage || "";
    const mediaDiagnostics = {
      stage: mediaStage,
      hasDirectPath: Boolean(message.directPath),
      hasMediaKey: Boolean(message.mediaKey),
    };

    if (!message.mediaData || mediaStage === "REUPLOADING") {
      return { error: "media_unavailable", ...mediaDiagnostics };
    }

    if (mediaStage !== "RESOLVED") {
      try {
        await message.downloadMedia({
          downloadEvenIfExpensive: true,
          rmrReason: 1,
        });
      } catch (_) {
        return { error: "media_unavailable", ...mediaDiagnostics };
      }
    }

    // If media is actively downloading (stage is FETCHING or not yet RESOLVED),
    // wait for it to transition to RESOLVED rather than immediately failing.
    if (
      message.mediaData &&
      message.mediaData.mediaStage !== "RESOLVED" &&
      !message.mediaData.mediaStage.includes("ERROR") &&
      message.mediaData.mediaStage !== "REUPLOADING"
    ) {
      const waitStart = Date.now();
      while (Date.now() - waitStart < 25_000) {
        await new Promise((r) => setTimeout(r, 200));
        const stage = message.mediaData.mediaStage || "";
        if (stage === "RESOLVED") break;
        if (stage.includes("ERROR") || stage === "REUPLOADING") break;
      }
    }

    const resolvedStage = message.mediaData?.mediaStage || "";
    if (resolvedStage.includes("ERROR") || resolvedStage === "FETCHING") {
      return { error: "media_unavailable", stage: resolvedStage, hasDirectPath: Boolean(message.directPath), hasMediaKey: Boolean(message.mediaKey) };
    }

    const mockQpl = {
      addAnnotations() { return this; },
      addPoint() { return this; },
    };
    let decrypted;
    try {
      const downloadManager = window.Store?.DownloadManager ||
        (typeof window.require === "function"
          ? window.require("WAWebDownloadManager")?.downloadManager
          : null);
      decrypted = await downloadManager.downloadAndMaybeDecrypt({
        directPath: message.directPath,
        encFilehash: message.encFilehash,
        filehash: message.filehash,
        mediaKey: message.mediaKey,
        mediaKeyTimestamp: message.mediaKeyTimestamp,
        type: message.type,
        signal: (new AbortController()).signal,
        downloadQpl: mockQpl,
      });
    } catch (decryptError) {
      // Fresh uploads often fail here for a short window (CDN copy not yet
      // visible); surface it as retryable instead of an opaque throw.
      return {
        error: "media_unavailable",
        ...mediaDiagnostics,
        detail: String(decryptError?.message || decryptError || "decrypt_failed").slice(0, 120),
      };
    }
    if (!decrypted) {
      return { error: "media_unavailable", ...mediaDiagnostics, detail: "empty_decrypted_payload" };
    }
    const data = await window.WWebJS.arrayBufferToBase64Async(decrypted);
    return {
      data,
      mimetype: message.mimetype || "application/octet-stream",
      filename: message.filename || "",
      filesize: message.size || null,
    };
  }, chatId, messageId);
}

async function handleReactMessage(req, res) {
  if (!state.ready) {
    json(res, 503, { success: false, error: "WhatsApp client is not ready yet" });
    return;
  }

  const payload = await readJsonBody(req);
  const messageId = String(payload.message_id || "").trim();
  const emoji = String(payload.emoji ?? ""); // empty string removes the reaction

  if (!messageId) {
    json(res, 400, { success: false, error: "message_id is required" });
    return;
  }

  try {
    const message = await withTimeout(
      () => client.getMessageById(messageId),
      PUPPETEER_OP_TIMEOUT_MS,
      `getMessageById(${messageId})`,
    );
    if (!message) {
      json(res, 404, { success: false, error: "Message not found" });
      return;
    }

    // whatsapp-web.js 1.34.7's Message.react() -> Client.sendReaction() is
    // broken against the current WhatsApp Web build: it calls the internal
    // sendReactionToMsg but the reaction never lands. Calling
    // sendReactionToMsg directly DOES work, so we do that instead.
    await withTimeout(
      () => client.pupPage.evaluate(async (msgId, reaction) => {
        const msg = window.require('WAWebCollections').Msg.get(msgId);
        if (!msg) return null;
        await window
          .require('WAWebSendReactionMsgAction')
          .sendReactionToMsg(msg, reaction);
        return true;
      }, messageId, emoji),
      PUPPETEER_OP_TIMEOUT_MS,
      `react(${messageId}, ${emoji})`,
    );

    const chatId = String(message?.id?.remote || message?.from || message?.to || "").trim();
    let normalizedMessage = await normalizeMessage(message, { forceLoadReactions: true });
    const reactionMatched = () => (
      emoji
        ? normalizedMessage.reactions.some((reaction) => reaction.by_me && reaction.emoji === emoji)
        : !normalizedMessage.reactions.some((reaction) => reaction.by_me)
    );

    if (!reactionMatched()) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await sleep(150 * (attempt + 1));
        const refreshedMessage = await withTimeout(
          () => client.getMessageById(messageId),
          PUPPETEER_OP_TIMEOUT_MS,
          `getMessageById(${messageId})[react-refresh-${attempt + 1}]`,
        );
        if (!refreshedMessage) continue;
        normalizedMessage = await normalizeMessage(refreshedMessage, { forceLoadReactions: true });
        if (reactionMatched()) break;
      }
    }

    if (chatId) {
      upsertNormalizedMessageInCache(chatId, normalizedMessage);
    }

    json(res, 200, {
      success: true,
      message_id: messageId,
      chat_id: chatId,
      emoji,
      message: normalizedMessage,
    });
  } catch (err) {
    console.error(`[bridge] reactMessage failed:`, err?.stack || err?.message || err);
    json(res, 500, { success: false, error: err?.message || String(err) });
  }
}

// ---------------------------------------------------------------------------
// HTTP server with response deadline
// ---------------------------------------------------------------------------

const RESPONSE_DEADLINE_MS = 20_000;

const server = http.createServer(async (req, res) => {
  // Hard deadline: if the handler hasn't responded in deadlineMs, force a 504.
  // Media downloads (audio / photo / video) can take up to 45s when CDN fetch / re-upload is needed.
  const isMediaReq = (req.url || "").startsWith("/media");
  const timeoutMs = isMediaReq ? 60_000 : RESPONSE_DEADLINE_MS;
  const deadline = setTimeout(() => {
    if (!res.writableEnded) {
      console.error(`[bridge] Response deadline exceeded for ${req.method} ${req.url}`);
      json(res, 504, { success: false, error: "Bridge response timed out" });
    }
  }, timeoutMs);

  try {
    const method = (req.method || "GET").toUpperCase();
    const urlObj = new URL(req.url || "/", `http://${HOST}:${PORT}`);

    if (method === "GET" && urlObj.pathname === "/health") {
      await handleHealth(urlObj, res);
    } else if (method === "GET" && urlObj.pathname === "/chats") {
      await handleChats(urlObj, res);
    } else if (method === "GET" && urlObj.pathname === "/messages") {
      await handleMessages(urlObj, res);
    } else if (method === "POST" && urlObj.pathname === "/send") {
      await handleSend(req, res);
    } else if (method === "POST" && urlObj.pathname === "/refresh") {
      await handleRefresh(req, res);
    } else if (method === "POST" && urlObj.pathname === "/seen") {
      await handleMarkSeen(req, res);
    } else if (method === "POST" && urlObj.pathname === "/shutdown") {
      await handleShutdown(req, res);
    } else if (method === "POST" && urlObj.pathname === "/delete") {
      await handleDelete(req, res);
    } else if (method === "POST" && urlObj.pathname === "/archive") {
      await handleArchive(req, res);
    } else if (method === "POST" && urlObj.pathname === "/unarchive") {
      await handleUnarchive(req, res);
    } else if (method === "POST" && urlObj.pathname === "/send-audio") {
      await handleSendAudio(req, res);
    } else if (method === "POST" && urlObj.pathname === "/edit-message") {
      await handleEditMessage(req, res);
    } else if (method === "POST" && urlObj.pathname === "/delete-message") {
      await handleDeleteMessage(req, res);
    } else if (method === "POST" && urlObj.pathname === "/send-media") {
      await handleSendMedia(req, res);
    } else if (method === "POST" && urlObj.pathname === "/send-image") {
      await handleSendImage(req, res);
    } else if (method === "POST" && urlObj.pathname === "/forward") {
      await handleForward(req, res);
    } else if (method === "GET" && urlObj.pathname === "/media") {
      await handleMedia(urlObj, res);
    } else if (method === "GET" && urlObj.pathname === "/link-preview") {
      await handleLinkPreview(urlObj, res);
    } else if (method === "GET" && urlObj.pathname === "/profile-pic") {
      await handleProfilePic(urlObj, res);
    } else if (method === "POST" && urlObj.pathname === "/react") {
      await handleReactMessage(req, res);
    } else {
      console.warn(`[bridge] 404: ${method} ${urlObj.pathname}`);
      json(res, 404, { success: false, error: `Not found: ${method} ${urlObj.pathname}` });
    }
  } catch (err) {
    if (!res.writableEnded) {
      json(res, 500, { success: false, error: err?.message || String(err) });
    }
  } finally {
    clearTimeout(deadline);
  }
});

// ---------------------------------------------------------------------------
// WhatsApp client events
// ---------------------------------------------------------------------------

function scheduleAuthenticatedReadyWatchdog() {
  if (authenticatedReadyWatchdogTimer || state.ready) return;

  authenticatedReadyWatchdogTimer = setTimeout(async () => {
    authenticatedReadyWatchdogTimer = null;
    if (state.ready || reconnecting) return;
    authenticatedReadyWatchdogAttempts += 1;

    try {
      const runtime = await withTimeout(
        () => client.pupPage.evaluate(() => {
          const store = globalThis.Store;
          const socket = typeof globalThis.require === "function"
            ? globalThis.require("WAWebSocketModel")?.Socket
            : null;
          const appState = socket?.state || store?.AppState?.state || globalThis.AuthStore?.AppState?.state || "";
          const myWid = store?.User?.getMaybeMePnUser?.() || store?.User?.getMaybeMeLidUser?.() || null;
          return {
            connected: appState === "CONNECTED",
            appState,
            hasWWebJS: Boolean(globalThis.WWebJS),
            myJid: myWid?._serialized || "",
          };
        }),
        5_000,
        "authenticated ready watchdog",
      );

      if (runtime.connected && runtime.hasWWebJS) {
        state.myJid = runtime.myJid || state.myJid;
        readyForcedByWatchdog = true;
        console.warn(
          "[bridge] whatsapp-web.js did not emit ready; runtime is CONNECTED, forcing ready",
        );
        client.emit("ready");
        return;
      }

      console.warn(
        `[bridge] Authenticated but runtime not ready yet (${runtime.appState || "unknown"}, attempt ${authenticatedReadyWatchdogAttempts})`,
      );
    } catch (err) {
      console.warn(
        `[bridge] Authenticated readiness probe failed (attempt ${authenticatedReadyWatchdogAttempts}):`,
        err?.message || err,
      );
    }

    if (authenticatedReadyWatchdogAttempts < 6) {
      scheduleAuthenticatedReadyWatchdog();
    } else {
      console.error("[bridge] Authenticated runtime never became usable; reconnecting...");
      triggerReconnection("authenticated_ready_timeout").catch((err) => {
        console.error("[bridge] Authenticated-ready reconnect failed:", err?.message || err);
      });
    }
  }, 5_000);
}

client.on("qr", async (qr) => {
  touchStatus("waiting_for_qr_scan");
  state.latestQrText = qr;
  try {
    state.latestQrSvg = await QRCode.toString(qr, {
      type: "svg",
      margin: 1,
      width: 260,
      color: {
        dark: "#1b120a",
        light: "#fffaf4",
      },
    });
  } catch (err) {
    state.latestQrSvg = "";
    console.error("Failed to build QR SVG:", err?.message || err);
  }
  console.log("Scan this QR in WhatsApp > Linked Devices:");
  qrcode.generate(qr, { small: true });
});

client.on("authenticated", () => {
  readyForcedByWatchdog = false;
  touchStatus("authenticated");
  state.latestQrText = "";
  state.latestQrSvg = "";
  console.log("[bridge] Authenticated.");
  authenticatedReadyWatchdogAttempts = 0;
  scheduleAuthenticatedReadyWatchdog();
});

client.on("ready", async () => {
  if (authenticatedReadyWatchdogTimer) {
    clearTimeout(authenticatedReadyWatchdogTimer);
    authenticatedReadyWatchdogTimer = null;
  }
  if (state.ready) {
    console.log("[bridge] Duplicate ready event ignored.");
    return;
  }
  state.ready = true;
  state.myJid = client.info?.wid?._serialized || state.myJid || "";
  touchStatus("ready");
  state.latestQrText = "";
  state.latestQrSvg = "";
  
  // Reset reconnect attempts on successful connection
  reconnectAttempts = 0;
  
  console.log("[bridge] Client ready. Validating connection...");
  
  // Validate that the Puppeteer connection actually works
  // This is critical after sleep/wake, as the client may report ready but the frame is detached
  if (!readyForcedByWatchdog) {
    try {
      await withTimeout(
        () => client.getState(),
        5000,
        "validate connection"
      );
    } catch (err) {
      console.error("[bridge] Connection validation failed:", err?.message);
      console.error("[bridge] Client reported ready but Puppeteer connection is broken. Triggering reconnection...");
      state.ready = false;
      triggerReconnection("ready_validation_failed").catch((err2) => {
        console.warn("[bridge] triggerReconnection after ready validation failed:", err2?.message);
      });
      return;
    }
  } else {
    console.warn("[bridge] Using independently verified WhatsApp runtime readiness.");
  }
  
  console.log("[bridge] Connection validated. Loading initial chat list...");

  // One-time initial load of the full chat list
  await refreshChatsFromPuppeteer();

  // Warm the most recent conversations in the background so first opens are fast.
  prewarmRecentChatsMessages().catch((err) => {
    console.warn("[bridge] startup prewarm error:", err?.message || err);
  });

  // Start fetching profile pictures in background (non-blocking)
  refreshProfilePics().catch(() => {});

  // WhatsApp can emit "ready" before its complete chat collection has
  // hydrated. Re-check once quickly, then use the normal gentle interval.
  scheduleBackgroundRefresh(8_000);
});

client.on("auth_failure", (msg) => {
  state.ready = false;
  touchStatus("auth_failure");
  state.latestQrText = "";
  state.latestQrSvg = "";
  console.error("[bridge] Auth failure:", msg);
});

// Monitor browser process for crashes
let browserCrashCheckInterval = null;
client.on("ready", () => {
  // Monitor the browser process for unexpected termination
  if (browserCrashCheckInterval) {
    clearInterval(browserCrashCheckInterval);
  }
  
  browserCrashCheckInterval = setInterval(() => {
    try {
      const browserProcess = client.pupBrowser?.process?.();
      if (browserProcess && browserProcess.killed) {
        console.error("[bridge] Browser process was terminated unexpectedly, triggering reconnection...");
        triggerReconnection("browser_process_killed").catch((err) => {
          console.warn("[bridge] triggerReconnection after browser crash failed:", err?.message);
        });
      }
    } catch (err) {
      // If we can't access the browser, something is wrong - might need reconnection
      console.warn("[bridge] Failed to check browser process:", err?.message);
    }
  }, 10000); // Check every 10 seconds
});

let healthCheckTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY_MS = 3000;
let reconnecting = false; // guard against concurrent reconnection attempts

/**
 * Reliably destroy and reinitialize the client.
 * Does NOT depend on the "disconnected" event firing, because after a
 * sleep/wake the Puppeteer connection may be broken in a way that prevents
 * whatsapp-web.js from emitting that event.
 */
async function triggerReconnection(reason) {
  if (reconnecting) {
    console.log(`[bridge] Reconnection already in progress, skipping (reason: ${reason})`);
    return;
  }

  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error("[bridge] Max reconnection attempts reached. Manual restart required.");
    return;
  }

  reconnecting = true;
  reconnectAttempts += 1;
  readyForcedByWatchdog = false;
  state.ready = false;
  touchStatus("reconnecting");

  console.log(`[bridge] Reconnecting (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}) reason: ${reason}`);

  try {
    await Promise.race([
      client.destroy(),
      sleep(5000),
    ]);
  } catch (err) {
    console.warn("[bridge] destroy error during reconnect:", err?.message);
  }

  // Kill any lingering browser process
  try {
    const browserProcess = client.pupBrowser?.process?.();
    if (browserProcess && !browserProcess.killed) {
      browserProcess.kill("SIGTERM");
    }
  } catch (_) {}

  await sleep(RECONNECT_DELAY_MS);

  console.log("[bridge] Reinitializing client...");
  reconnecting = false;
  client.initialize().catch((err) => {
    console.error(`[bridge] Reconnect attempt ${reconnectAttempts} failed:`, err?.message || err);
    reconnecting = false;
    // Schedule a retry so we don't get permanently stuck when initialize fails
    // (health check timer is gone at this point — it only restarts on "ready")
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const retryDelay = RECONNECT_DELAY_MS * 4; // ~12s, longer to let things settle
      console.warn(`[bridge] Scheduling reconnect retry in ${retryDelay}ms...`);
      setTimeout(() => {
        triggerReconnection("initialize_failed_retry").catch((e) => {
          console.error("[bridge] Retry after initialize failure failed:", e?.message || e);
        });
      }, retryDelay);
    }
  });
}

client.on("disconnected", (reason) => {
  state.ready = false;
  touchStatus(`disconnected:${reason}`);
  state.latestQrText = "";
  state.latestQrSvg = "";

  // Clear health check timer when disconnected
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }

  // Clear browser crash check when disconnected
  if (browserCrashCheckInterval) {
    clearInterval(browserCrashCheckInterval);
    browserCrashCheckInterval = null;
  }

  console.error("[bridge] Disconnected:", reason);
  triggerReconnection(`disconnected:${reason}`).catch((err) => {
    console.error("[bridge] triggerReconnection failed:", err?.message || err);
  });
});

// --- Connection health monitor for sleep/wake recovery ---
// Periodically check if the connection is stale and reconnect if needed.
const STALE_CONNECTION_CHECK_MS = 60000; // Check every 60 seconds (increased from 30s)
let lastHealthyCheckTime = Date.now();
let consecutiveFailedHealthChecks = 0;
let healthCheckInProgress = false;

async function checkConnectionHealth() {
  // Prevent concurrent health checks
  if (healthCheckInProgress) {
    return;
  }

  try {
    healthCheckInProgress = true;

    if (!state.ready) {
      // If not ready, don't perform extra health checks
      return;
    }

    const probe = await probeClientConnection();
    if (!probe.ok) {
      consecutiveFailedHealthChecks += 1;

      // Reconnect immediately on detached-frame/runtime/timeouts after sleep/wake.
      // For non-transient errors (for example a temporary non-CONNECTED state),
      // require repeated failures before forcing a reconnect.
      const shouldReconnect = probe.transient || consecutiveFailedHealthChecks >= 3;

      console.warn(
        `[bridge] Health check failed (${consecutiveFailedHealthChecks}): ${probe.error}`
      );

      if (shouldReconnect) {
        console.error(
          "[bridge] Triggering reconnection after health check failure..."
        );
        consecutiveFailedHealthChecks = 0;
        triggerReconnection(`health_check_failed:${probe.error || "unknown"}`).catch((err) => {
          console.error("[bridge] triggerReconnection from health check failed:", err?.message || err);
        });
      }
      return;
    }

    // If we got here, the connection is healthy
    lastHealthyCheckTime = Date.now();
    consecutiveFailedHealthChecks = 0;
  } finally {
    healthCheckInProgress = false;
  }
}

// Start the health check timer after client is initialized
client.on("ready", () => {
  healthCheckTimer = setInterval(() => {
    // Wrap in try-catch to prevent unhandled errors from crashing the process
    try {
      checkConnectionHealth().catch((err) => {
        console.error("[bridge] Health check exception:", err?.message || err);
      });
    } catch (err) {
      console.error("[bridge] Health check sync exception:", err?.message || err);
    }
  }, STALE_CONNECTION_CHECK_MS);
  console.log("[bridge] Started connection health monitor (checks every 60s)");
});

// --- Stalled-state recovery ---
// If the client has been not-ready for > 3 minutes and nothing is actively
// reconnecting (e.g., initialize() failed and left us stuck), force a new
// reconnect attempt. This is the safety net for the case where the health
// check timer was cleared and never restarted.
let lastKnownReadyAt = 0; // 0 = never been ready in this session
client.on("ready", () => { lastKnownReadyAt = Date.now(); });

const STALLED_CHECK_INTERVAL_MS = 2 * 60_000; // check every 2 min
const STALLED_THRESHOLD_MS = 3 * 60_000;      // trigger if stuck > 3 min

setInterval(() => {
  if (state.ready) return; // healthy, nothing to do
  if (reconnecting) return; // already working on it
  if (lastKnownReadyAt === 0) return; // still in initial startup, skip
  const stuckMs = Date.now() - lastKnownReadyAt;
  if (stuckMs > STALLED_THRESHOLD_MS) {
    console.warn(`[bridge] Stuck in non-ready state for ${Math.round(stuckMs / 1000)}s — triggering stalled recovery`);
    lastKnownReadyAt = Date.now(); // reset so we don't hammer every 2 min
    triggerReconnection("stalled_state_recovery").catch((e) => {
      console.error("[bridge] Stalled recovery reconnect failed:", e?.message || e);
    });
  }
}, STALLED_CHECK_INTERVAL_MS);

// --- Event-driven message caching ---

client.on("message", (msg) => {
  touchStatus("message_received");
  appendMessageToCache(msg);
  updateChatOnMessage(msg);
});

client.on("message_create", (msg) => {
  touchStatus("message_created");
  appendMessageToCache(msg);
  updateChatOnMessage(msg);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

process.on("SIGINT", async () => {
  await shutdownBridge("SIGINT");
});

process.on("SIGTERM", async () => {
  await shutdownBridge("SIGTERM");
});

process.on("uncaughtException", (err) => {
  console.error("[bridge] Uncaught exception:", err?.stack || err?.message || err);
  // If the bridge is in a broken state (e.g. Puppeteer context destroyed during
  // sleep/wake), attempt to reconnect rather than letting the process die.
  if (isTransientClientError(err) || String(err?.message || "").toLowerCase().includes("navigation")) {
    console.error("[bridge] Transient Puppeteer error — triggering reconnection instead of crashing.");
    triggerReconnection("uncaught_exception").catch((e) => {
      console.error("[bridge] triggerReconnection from uncaughtException failed:", e?.message || e);
    });
  } else {
    // For non-transient errors, shut down cleanly so the Tauri app can restart the bridge.
    shutdownBridge("uncaught_exception", 1).catch(() => process.exit(1));
  }
});

process.on("unhandledRejection", (reason) => {
  const message = String(reason?.message || reason || "");
  console.error("[bridge] Unhandled rejection:", reason?.stack || message);
  if (isTransientClientError(reason) || message.toLowerCase().includes("navigation")) {
    console.error("[bridge] Transient Puppeteer rejection — triggering reconnection.");
    triggerReconnection("unhandled_rejection").catch((e) => {
      console.error("[bridge] triggerReconnection from unhandledRejection failed:", e?.message || e);
    });
  }
  // For other unhandled rejections, log but don't crash — the bridge stays alive.
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

server.listen(PORT, HOST, () => {
  console.log(`[bridge] WhatsApp bridge API listening on http://${HOST}:${PORT}`);
  console.log(`[bridge] Auth client ID: ${AUTH_CLIENT_ID}, headless: ${HEADLESS}`);
  console.log(`[bridge] Background refresh interval: ${BG_REFRESH_INTERVAL_MS}ms`);
  client.initialize().catch((err) => {
    touchStatus("init_failed");
    console.error("[bridge] Client initialize failed:", err?.message || err);
  });
});
