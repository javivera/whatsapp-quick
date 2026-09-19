// WhatsApp Quick — compact keyboard-first palette.
// Talks to the shared whatsapp_web_listener bridge through the same Tauri
// commands the full app uses, so the WhatsApp session is reused as-is.

const CHAT_LIMIT = 300;
const CHATS_POLL_MS = 5000;
const THREAD_POLL_MS = 4000;

const el = {
  shell: document.querySelector(".shell"),
  status: document.getElementById("status"),
  search: document.getElementById("search"),
  chatList: document.getElementById("chat-list"),
  chatsEmpty: document.getElementById("chats-empty"),
  threadHead: document.getElementById("thread-head"),
  messages: document.getElementById("messages"),
  msgMenu: document.getElementById("msg-menu"),
  composer: document.getElementById("composer"),
  composerBanner: document.getElementById("composer-banner"),
  pendingMedia: document.getElementById("pending-media"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  mic: document.getElementById("mic"),
  recordBanner: document.getElementById("record-banner"),
  recordTimer: document.getElementById("record-timer"),
  toast: document.getElementById("toast"),
};

const state = {
  chats: [],
  filtered: [],
  activeChatId: null,
  messages: [],
  selected: 0,
  pane: "chats", // "chats" | "messages" | "input"
  threadPane: "input", // remembered right-side pane (input or messages)
  selectedMsgId: null,
  editingMessageId: null,
  replyToId: null,
  pendingMedia: [], // [{ key, mimetype, data (base64), filename, previewUrl }]
  sendingMedia: false,
  menuOpen: false,
  menuItems: [],
  menuIndex: 0,
  menuMsg: null,
  menuConfirm: false,
  playingId: null,
  playingAudio: null,
  bridgeReady: false,
  pinBottom: false,
  inflight: false,
  lastChatsAt: 0,
  lastThreadAt: 0,
  mediaCache: new Map(),
  mediaLoadsInFlight: new Map(),
  // messageId -> { attempts, nextAt } for media that failed to load, so a
  // failed thumbnail is retried (with backoff) instead of staying broken.
  mediaFailures: new Map(),
  profilePics: new Map(),
  localReactions: new Map(),
  filter: "",
  recording: false,
  mediaRecorder: null,
  recordingChunks: [],
  recordingStartTime: 0,
  recordingTimerInterval: null,
};

function invoke(command, args = {}) {
  const tauri = window.__TAURI__;
  if (!tauri || !tauri.core || typeof tauri.core.invoke !== "function") {
    return Promise.reject(new Error("Tauri IPC unavailable"));
  }
  return tauri.core.invoke(command, args);
}

/* ---------------- formatting ---------------- */

function toMs(ts) {
  const n = Number(ts) || 0;
  return n > 1e12 ? n : n * 1000;
}

function fmtTime(ts) {
  const d = new Date(toMs(ts));
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  const days = (now - d) / 86400000;
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "2-digit", month: "2-digit" });
}

function initials(name) {
  const clean = String(name || "?").trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function clamp(text, max) {
  const value = String(text || "");
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function mediaLabel(msg) {
  const type = String(msg.type || "").toLowerCase();
  if (type === "image" || type === "sticker") return "photo";
  if (type === "video") return "video";
  if (type === "audio" || type === "ptt") return "voice";
  if (type === "document") return "document";
  if (type === "location" || type === "live_location") return "location";
  if (type === "vcard" || type === "multi_vcard") return "contact";
  return type || "media";
}

function isAudioType(msg) {
  const type = String(msg.type || "").toLowerCase();
  return type === "audio" || type === "ptt";
}

async function ensureProfilePic(chatId) {
  if (state.profilePics.has(chatId)) return state.profilePics.get(chatId);
  state.profilePics.set(chatId, "fetching");
  try {
    const payload = await invoke("bridge_get_profile_pic", { chatId });
    const url = (payload && (payload.url || payload.data_url)) || null;
    state.profilePics.set(chatId, url);
    if (url) renderChats();
    return url;
  } catch (_) {
    state.profilePics.set(chatId, null);
    return null;
  }
}

/* ---------------- bridge ---------------- */

async function ensureBridge() {
  try {
    const health = await invoke("ensure_bridge");
    setStatus(Boolean(health && health.ready) ? "ready" : "warn");
    state.bridgeReady = Boolean(health && health.ready);
    return state.bridgeReady;
  } catch (err) {
    setStatus("down");
    state.bridgeReady = false;
    showFault(`ensure_bridge: ${err && err.message ? err.message : err}`);
    return false;
  }
}

function showFault(message) {
  const node = document.createElement("p");
  node.className = "fault";
  node.textContent = String(message || "unknown error");
  el.chatList.replaceChildren(node);
  el.chatsEmpty.classList.add("hidden");
}

let toastTimer = null;
// Last seen scrollTop of the thread: used to tell user scroll-ups apart
// from our own programmatic scrolls to the bottom (which only move down).
let lastMsgTop = 0;
function toast(text) {
  el.toast.textContent = String(text || "error");
  el.toast.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add("hidden"), 4500);
}

function setStatus(kind) {  el.status.classList.toggle("ready", kind === "ready");
  el.status.classList.toggle("down", kind === "down");
  el.status.title =
    kind === "ready" ? "Bridge connected" : kind === "down" ? "Bridge unreachable" : "Bridge starting…";
}

async function refreshChats() {
  if (state.inflight) return;
  state.inflight = true;
  try {
    const payload = await invoke("bridge_get_chats", {
      limit: CHAT_LIMIT,
      includeGroups: false,
      query: null,
    });
    const chats = (Array.isArray(payload && payload.chats) ? payload.chats : []).filter(
      (c) => !c.is_group,
    );
    state.chats = chats;
    state.bridgeReady = true;
    setStatus("ready");
    applyFilter();
    state.lastChatsAt = Date.now();
  } catch (err) {
    setStatus("down");
    showFault(`chats: ${err && err.message ? err.message : err}`);
  } finally {
    state.inflight = false;
  }
}

async function openChat(chatId) {
  if (!chatId) return;
  const chat = state.chats.find((c) => c.id === chatId);
  // Entering a chat ends the search: restore the full sidebar and point
  // the selection at the opened chat.
  if (state.filter !== "") {
    el.search.value = "";
    state.filter = "";
    state.filtered = state.chats.filter((c) => !c.is_group);
  }
  const openedIdx = state.filtered.findIndex((c) => c.id === chatId);
  if (openedIdx >= 0) state.selected = openedIdx;
  state.activeChatId = chatId;
  state.selectedMsgId = null;
  // Opening a chat marks it read: clear the badge immediately and tell
  // the bridge to sendSeen (so WhatsApp itself clears the unread count).
  // Otherwise stale badges linger next to previews of our own messages.
  const opened = state.chats.find((c) => c.id === chatId);
  if (opened && (Number(opened.unread_count) || 0) > 0) {
    opened.unread_count = 0;
  }
  renderChats();
  invoke("bridge_mark_seen", { chatId }).catch(() => {});
  // Pin to the bottom while the new thread (and its late-loading media)
  // settles, so expanding images can't leave us stuck mid-thread.
  state.pinBottom = true;
  renderThreadHead(chat);
  el.messages.innerHTML = "";
  state.messages = [];
  state.lastThreadKey = null;
  el.messages.scrollTop = 0;
  lastMsgTop = 0;
  await refreshThread();
  renderChats();
  setPane("input");
  setTimeout(() => {
    state.pinBottom = false;
  }, 4000);
}

async function refreshThread() {
  const chatId = state.activeChatId;
  if (!chatId) return;
  try {
    const payload = await invoke("bridge_get_messages", { chatId, limit: 60 });
    if (chatId !== state.activeChatId) return;
    const messages = Array.isArray(payload && payload.messages) ? payload.messages : [];
    // Capture before the re-render: polls must not yank a user who scrolled
    // up to read history back to the bottom.
    const wasNear = state.messages.length === 0 || isNearBottom(120);
    const prevLastId = state.messages.length
      ? state.messages[state.messages.length - 1].id
      : null;
    const grew =
      messages.length !== state.messages.length ||
      (messages.length > 0 && messages[messages.length - 1].id !== prevLastId);
    // The bridge can't read reactions back (upstream incompatibility), so
    // re-apply the user's locally-known reactions after every poll.
    for (const m of messages) {
      if (state.localReactions.has(m.id)) {
        m.reactions = state.localReactions.get(m.id);
      }
    }
    const key = messages
      .map(
        (m) =>
          `${m.id}|${m.type}|${m.body}|${(Array.isArray(m.reactions) ? m.reactions : []).map((r) => `${r.emoji}${r.count}`).join(",")}`,
      )
      .join("~");
    state.messages = messages;
    if (state.selectedMsgId && !messages.some((m) => m.id === state.selectedMsgId)) {
      state.selectedMsgId = null;
    }
    const shouldScroll = state.pinBottom || (wasNear && grew);
    if (key === state.lastThreadKey && !shouldScroll) {
      // No visible change: skip the re-render so polling can't flicker the
      // view or steal the scroll position while reading history.
    } else {
      state.lastThreadKey = key;
      renderMessages(shouldScroll);
    }
    // The early-out above means a media load that failed once would never be
    // retried by a poll; retry the failed thumbnails directly on the DOM.
    retryDueMedia();
    // While the chat is open on screen it counts as read: clear any badge
    // (fires at most once per batch of new arrivals, since it zeroes the
    // count optimistically).
    const activeChat = state.chats.find((c) => c.id === chatId);
    if (activeChat && (Number(activeChat.unread_count) || 0) > 0) {
      activeChat.unread_count = 0;
      renderChats();
      invoke("bridge_mark_seen", { chatId }).catch(() => {});
    }
    state.lastThreadAt = Date.now();
  } catch (err) {
    /* transient; the next poll retries */
  }
}

/* ---------------- rendering ---------------- */

function applyFilter() {
  const q = state.filter.trim().toLowerCase();
  // Sidebar is DMs only: never show group chats (@g.us / is_group).
  const dms = state.chats.filter((c) => !c.is_group);
  if (!q) {
    state.filtered = dms;
  } else {
    state.filtered = dms.filter((c) =>
      `${c.name || ""} ${c.id || ""}`.toLowerCase().includes(q),
    );
  }
  if (state.selected >= state.filtered.length) {
    state.selected = Math.max(0, state.filtered.length - 1);
  }
  renderChats();
}

function renderChats() {
  const frag = document.createDocumentFragment();
  state.filtered.forEach((chat, index) => {
    const row = document.createElement("div");
    row.className = "row" + (index === state.selected ? " sel" : "");
    row.setAttribute("role", "option");
    row.dataset.chatId = chat.id;

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    const picUrl = chat.profile_pic_url || state.profilePics.get(chat.id);
    if (picUrl && picUrl !== "fetching") avatar.style.backgroundImage = `url("${picUrl}")`;
    else avatar.textContent = initials(chat.name);
    if (!chat.profile_pic_url && !state.profilePics.has(chat.id) && index < 30) {
      ensureProfilePic(chat.id);
    }

    const main = document.createElement("div");
    main.className = "row-main";

    const top = document.createElement("div");
    top.className = "row-top";
    const name = document.createElement("span");
    name.className = "row-name";
    name.textContent = chat.name || chat.id;
    const time = document.createElement("span");
    time.className = "row-time";
    time.textContent = fmtTime(chat.timestamp);
    top.append(name, time);

    const sub = document.createElement("div");
    sub.className = "row-sub";
    const preview = document.createElement("span");
    preview.className = "row-preview";
    const last = chat.last_message || {};
    const body = clamp(String(last.body || "").replace(/\s+/g, " ").trim(), 160);
    const mediaFallback = last.type && last.type !== "chat" ? `[${mediaLabel(last)}]` : "";
    const text = body || mediaFallback;
    if (last.from_me) {
      // Make it obvious the preview is our own message, not theirs.
      preview.textContent = text ? `You: ${text}` : "You";
      preview.classList.add("mine");
    } else {
      preview.textContent = text;
    }
    sub.append(preview);
    const unread = Number(chat.unread_count) || 0;
    if (unread > 0) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = unread > 99 ? "99+" : String(unread);
      sub.append(badge);
    }

    main.append(top, sub);
    row.append(avatar, main);
    frag.append(row);
  });

  el.chatList.replaceChildren(frag);
  el.chatsEmpty.classList.toggle("hidden", state.filtered.length > 0);
  scrollSelectedIntoView();
}

function scrollSelectedIntoView() {
  const node = el.chatList.children[state.selected];
  if (node && node.scrollIntoView) node.scrollIntoView({ block: "nearest" });
}

function renderThreadHead(chat) {
  el.threadHead.replaceChildren();
  const name = document.createElement("span");
  name.className = "thread-name";
  name.textContent = chat ? chat.name || chat.id : "Pick a chat";
  const meta = document.createElement("span");
  meta.className = "thread-meta";
  meta.textContent = chat && chat.is_group ? "group" : "direct";
  el.threadHead.append(name, meta);
}

function renderMessages(scrollToEnd) {
  const chat = state.chats.find((c) => c.id === state.activeChatId);
  const isGroup = Boolean(chat && chat.is_group);
  const frag = document.createDocumentFragment();

  for (const msg of state.messages) {
    const type = String(msg.type || "").toLowerCase();
    const isChat = type === "chat" && String(msg.body || "").trim();
    const isSystem = ["revoked", "call_log", "e2e_notification", "notification_template"].includes(type);
    const selected = msg.id === state.selectedMsgId;
    const playing = msg.id === state.playingId;

    const node = document.createElement("div");
    node.className =
      "msg" +
      (msg.from_me ? " out" : "") +
      (isSystem ? " meta" : "") +
      (selected ? " sel" : "") +
      (playing ? " playing" : "");
    node.dataset.messageId = msg.id;

    if (isSystem) {
      const text = String(msg.body || type).trim();
      node.textContent = text.charAt(0).toUpperCase() + text.slice(1);
      frag.append(node);
      continue;
    }

    if (isGroup && !msg.from_me && msg.author) {
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = String(msg.author).replace(/@.*$/, "");
      node.append(who);
    }

    if (isChat) {
      node.append(renderBodyWithLinks(msg));
    } else if (type === "image" || type === "video" || type === "sticker") {
      const cached = state.mediaCache.get(msg.id);
      const thumb = document.createElement("img");
      thumb.className = "media-thumb";
      thumb.dataset.msgId = msg.id;
      thumb.alt = type === "video" ? "video" : "photo";
      thumb.loading = "lazy";
      // Late-loading media expands the thread after the initial
      // scroll-to-bottom, leaving the view stuck mid-thread. Re-pin on
      // load while the new chat is settling (or the user was at bottom).
      thumb.addEventListener("load", () => {
        if (state.pinBottom || isNearBottom()) scrollToBottom();
      });
      if (cached && cached.src) {
        thumb.src = cached.src;
        thumb.classList.add("loaded");
      } else {
        thumb.src = TRANSPARENT_PIXEL;
        if (state.mediaFailures.has(msg.id)) markThumbFailed(thumb, msg.id);
        ensureMediaThumb(msg.id, thumb);
      }
      node.append(thumb);
      if (msg.body) {
        const caption = document.createElement("div");
        caption.className = "caption";
        caption.textContent = String(msg.body);
        node.append(caption);
      }
    } else {
      const chip = document.createElement("span");
      chip.className = "media-chip";
      const label = playing ? "🔊 playing" : `${isAudioType(msg) ? "▶ " : "▸ "}${mediaLabel(msg)}`;
      chip.textContent = label;
      chip.title = msg.title || msg.filename || (isAudioType(msg) ? "Play" : "Open");
      chip.addEventListener("click", () => {
        if (isAudioType(msg)) playAudio(msg);
        else openMediaExternally(msg);
      });
      node.append(chip);
      if (msg.body) {
        const caption = document.createElement("div");
        caption.className = "caption";
        caption.textContent = String(msg.body);
        node.append(caption);
      }
    }

    const stamp = document.createElement("span");
    stamp.className = "stamp";
    stamp.textContent = fmtTime(msg.timestamp);
    node.append(stamp);

    if (Array.isArray(msg.reactions) && msg.reactions.length) {
      const rx = document.createElement("span");
      rx.className = "rx" + (msg.reactions.some((r) => r.by_me) ? " mine" : "");
      rx.textContent = msg.reactions
        .map((r) => `${r.emoji}${r.count > 1 ? r.count : ""}`)
        .join(" ");
      node.append(rx);
    }

    frag.append(node);
  }

  el.messages.replaceChildren(frag);
  if (scrollToEnd) {
    // Scroll now plus on the next frames: image placeholders have no real
    // size yet, so a single synchronous scroll lands short. The deferred
    // passes re-check first so they can't drag the view back down after
    // the user scrolled up to read history.
    scrollToBottom();
    requestAnimationFrame(() => {
      if (!state.pinBottom && !isNearBottom(120)) return;
      scrollToBottom();
      requestAnimationFrame(() => {
        if (!state.pinBottom && !isNearBottom(120)) return;
        scrollToBottom();
      });
    });
  }
}

function scrollToBottom() {
  el.messages.scrollTop = el.messages.scrollHeight;
}

function isNearBottom(px = 80) {
  return (
    el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight <
    px
  );
}

const MEDIA_CACHE_LIMIT = 60;
// A real 1x1 transparent PNG: the old placeholder was a truncated GIF that
// WebKit refuses to decode, so unloaded photos showed a broken-image glyph.
const TRANSPARENT_PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
// Retry a failed media load a few times with backoff before showing "unavailable".
const MEDIA_RETRY_ATTEMPT_DELAYS_MS = [1000, 3000, 8000, 20000];

function cacheMediaEntry(messageId, entry) {
  if (state.mediaCache.has(messageId)) state.mediaCache.delete(messageId);
  state.mediaCache.set(messageId, entry);
  while (state.mediaCache.size > MEDIA_CACHE_LIMIT) {
    const oldestKey = state.mediaCache.keys().next().value;
    if (oldestKey === undefined) break;
    state.mediaCache.delete(oldestKey);
  }
}

async function fetchMediaSrc(messageId) {
  const cached = state.mediaCache.get(messageId);
  if (cached && cached.src) return cached.src;

  const inFlight = state.mediaLoadsInFlight.get(messageId);
  if (inFlight) return inFlight;

  const promise = (async () => {
    const payload = await invoke("bridge_get_media", {
      chatId: state.activeChatId,
      messageId,
    });
    const mimetype = String((payload && payload.mimetype) || "").toLowerCase();
    let src = null;
    let kind = "image";
    if (mimetype.startsWith("image/") && payload.data) {
      src = `data:${payload.mimetype || "image/jpeg"};base64,${payload.data}`;
    } else if (mimetype.startsWith("video/")) {
      src = payload.poster_data_url || null;
      kind = "video";
    } else if (payload.data) {
      src = `data:${payload.mimetype || "application/octet-stream"};base64,${payload.data}`;
    }
    if (!src) throw new Error("no renderable media data");
    cacheMediaEntry(messageId, { kind, src });
    state.mediaFailures.delete(messageId);
    return src;
  })();

  state.mediaLoadsInFlight.set(messageId, promise);
  try {
    return await promise;
  } finally {
    state.mediaLoadsInFlight.delete(messageId);
  }
}

function nextMediaRetryDelay(attempts) {
  const index = Math.min(attempts - 1, MEDIA_RETRY_ATTEMPT_DELAYS_MS.length - 1);
  return MEDIA_RETRY_ATTEMPT_DELAYS_MS[Math.max(0, index)];
}

function isMediaRetryDue(messageId) {
  const failure = state.mediaFailures.get(messageId);
  return !failure || Date.now() >= failure.nextAt;
}

function markThumbFailed(imgEl, messageId) {
  const failure = state.mediaFailures.get(messageId);
  if (!failure) return;
  imgEl.classList.add("media-failed");
  imgEl.title = "Photo not loaded yet — click to retry";
  const exhausted = failure.attempts > MEDIA_RETRY_ATTEMPT_DELAYS_MS.length;
  imgEl.alt = exhausted ? "photo unavailable" : "photo";
  if (imgEl.dataset.retryBound === "1") return;
  imgEl.dataset.retryBound = "1";
  imgEl.addEventListener("click", () => {
    // Manual retry always wins: clear the backoff and try again now.
    state.mediaFailures.delete(messageId);
    imgEl.classList.remove("media-failed");
    imgEl.alt = "photo";
    ensureMediaThumb(messageId, imgEl);
  });
}

function recordMediaFailure(messageId) {
  const previous = state.mediaFailures.get(messageId);
  const attempts = (previous ? previous.attempts : 0) + 1;
  state.mediaFailures.set(messageId, {
    attempts,
    nextAt: Date.now() + nextMediaRetryDelay(attempts),
  });
  return state.mediaFailures.get(messageId);
}

/**
 * Retry media that failed earlier: thread polls used to skip re-rendering when
 * nothing but the media changed, so one transient bridge failure left a photo
 * broken forever. Only touches unloaded images whose backoff has elapsed.
 */
function retryDueMedia() {
  const thumbs = el.messages.querySelectorAll("img.media-thumb[data-msg-id]");
  for (const imgEl of thumbs) {
    const messageId = imgEl.dataset.msgId;
    if (!messageId || imgEl.classList.contains("loaded")) continue;
    // A cache hit whose image element never got it (re-render race) is applied
    // straight away instead of being skipped forever.
    const cached = state.mediaCache.get(messageId);
    if (cached && cached.src) {
      imgEl.src = cached.src;
      imgEl.classList.add("loaded");
      imgEl.classList.remove("media-failed");
      continue;
    }
    if (state.mediaLoadsInFlight.has(messageId)) continue;
    if (!isMediaRetryDue(messageId)) continue;
    ensureMediaThumb(messageId, imgEl);
  }
}

async function ensureMediaThumb(messageId, imgEl) {
  try {
    const src = await fetchMediaSrc(messageId);
    if (imgEl.isConnected) {
      imgEl.src = src;
      imgEl.classList.add("loaded");
      imgEl.classList.remove("media-failed");
      // The `load` listener added in renderMessages fires here and re-pins
      // to the bottom. Fall back to an explicit check in case the event
      // was missed (e.g. cached data URL resolving synchronously).
      if (imgEl.complete && (state.pinBottom || isNearBottom())) {
        scrollToBottom();
      }
    }
  } catch (_) {
    // Keep the placeholder but remember the failure: the next thread poll
    // retries it (see retryDueMedia) and a click retries it immediately.
    recordMediaFailure(messageId);
    if (imgEl.isConnected) markThumbFailed(imgEl, messageId);
  }
}

async function playAudio(msg) {
  if (state.playingAudio) {
    state.playingAudio.pause();
    state.playingAudio = null;
    state.playingId = null;
  }
  try {
    const payload = await invoke("bridge_get_media", {
      chatId: state.activeChatId,
      messageId: msg.id,
    });
    const base64 = payload && payload.data;
    if (!base64) return;
    const mime = payload.mimetype || "audio/ogg; codecs=opus";
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    state.playingId = msg.id;
    state.playingAudio = audio;
    renderMessages(false);
    const stop = () => {
      state.playingId = null;
      state.playingAudio = null;
      URL.revokeObjectURL(url);
      renderMessages(false);
    };
    audio.onended = stop;
    audio.onerror = stop;
    await audio.play();
  } catch (err) {
    state.playingId = null;
    state.playingAudio = null;
  }
}

/* ---------------- links & opening media externally ---------------- */

function cleanupUrlCandidate(value) {
  return String(value || "").trim().replace(/[)\],.!?:;]+$/g, "");
}

function extractMessageUrls(msg) {
  const direct = Array.isArray(msg.links)
    ? msg.links.map(cleanupUrlCandidate).filter(Boolean)
    : [];
  if (direct.length) return direct;
  const body = String(msg.body || "");
  const matches = body.match(/https?:\/\/[^\s<>"'`]+/gi) || [];
  return matches.map(cleanupUrlCandidate).filter(Boolean);
}

function primaryMessageUrl(msg) {
  return extractMessageUrls(msg)[0] || "";
}

function hasOpenableMedia(msg) {
  if (!msg.has_media) return false;
  const type = String(msg.type || "").toLowerCase();
  return ![
    "audio", "ptt", "sticker", "location", "live_location", "vcard", "multi_vcard",
  ].includes(type);
}

function linkHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_) {
    return url;
  }
}

function openLink(url) {
  invoke("open_url", { url })
    .then(() => toast(`Opened ${linkHost(url)}`))
    .catch((err) => toast("Open failed: " + (err && err.message ? err.message : err)));
}

async function openMediaExternally(msg) {
  toast("Opening…");
  try {
    const payload = await invoke("bridge_get_media", {
      chatId: state.activeChatId,
      messageId: msg.id,
    });
    const data = payload && payload.data;
    if (!data) throw new Error("no media data");
    await invoke("open_media_external", {
      data,
      mimetype: payload.mimetype || "application/octet-stream",
      filename: payload.filename || msg.filename || "",
    });
  } catch (err) {
    toast("Open failed: " + (err && err.message ? err.message : err));
  }
}

/**
 * Enter on a selected message does the obvious thing: play a voice note,
 * open a link in the browser, or open an image/video/document in the OS
 * default app. Plain text messages fall back to the action menu.
 */
function performPrimaryAction(msg) {
  if (!msg) return;
  if (isAudioType(msg)) {
    playAudio(msg);
    return;
  }
  const linkUrl = primaryMessageUrl(msg);
  if (linkUrl && !msg.has_media) {
    openLink(linkUrl);
    return;
  }
  if (hasOpenableMedia(msg)) {
    openMediaExternally(msg);
    return;
  }
  openMenuForSelected();
}

/** Render a chat body with its URLs as clickable links. */
function renderBodyWithLinks(msg) {
  const body = clamp(msg.body, 4000);
  const frag = document.createDocumentFragment();
  const pattern = /https?:\/\/[^\s<>"'`]+/gi;
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    const before = body.slice(lastIndex, match.index);
    if (before) frag.append(document.createTextNode(before));
    const rawUrl = match[0];
    const cleanUrl = cleanupUrlCandidate(rawUrl);
    const a = document.createElement("a");
    a.className = "msg-link";
    a.textContent = cleanUrl;
    a.title = "Open in browser";
    a.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openLink(cleanUrl);
    });
    frag.append(a);
    lastIndex = match.index + cleanUrl.length;
  }
  const tail = body.slice(lastIndex);
  if (tail) frag.append(document.createTextNode(tail));
  return frag;
}

/* ---------------- voice recording ---------------- */

function updateRecordingTimer() {
  if (!state.recordingStartTime) return;
  const elapsed = Math.floor((Date.now() - state.recordingStartTime) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = String(elapsed % 60).padStart(2, "0");
  el.recordTimer.textContent = `${minutes}:${seconds}`;
}

function showRecordingBanner() {
  el.recordBanner.classList.remove("hidden");
  el.mic.classList.add("recording");
  updateRecordingTimer();
}

function hideRecordingBanner() {
  el.recordBanner.classList.add("hidden");
  el.mic.classList.remove("recording");
  if (state.recordingTimerInterval) {
    clearInterval(state.recordingTimerInterval);
    state.recordingTimerInterval = null;
  }
}

async function waitForLiveAudioTrack(stream, { timeoutMs = 1200 } = {}) {
  const [track] = Array.from(stream?.getAudioTracks?.() || []);
  if (!track) return;
  if (track.readyState === "live" && !track.muted) return;

  await new Promise((resolve) => {
    let settled = false;
    let timer = 0;

    const cleanup = () => {
      if (timer) window.clearTimeout(timer);
      track.removeEventListener("unmute", handleReady);
      track.removeEventListener("ended", handleReady);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const handleReady = () => finish();

    track.addEventListener("unmute", handleReady, { once: true });
    track.addEventListener("ended", handleReady, { once: true });
    timer = window.setTimeout(finish, timeoutMs);
  });
}

async function startRecording() {
  if (state.recording) return;
  if (!state.activeChatId) {
    toast("Open a chat first, then record");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    await waitForLiveAudioTrack(stream);

    let mimeType = "audio/ogg; codecs=opus";
    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = "audio/webm; codecs=opus";
    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = "audio/webm";
    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = "";

    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    state.recordingChunks = [];

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) state.recordingChunks.push(event.data);
    };
    recorder.onstop = () => stream.getTracks().forEach((track) => track.stop());
    recorder.start(100);

    state.mediaRecorder = recorder;
    state.recording = true;
    state.recordingStartTime = Date.now();
    state.recordingTimerInterval = setInterval(updateRecordingTimer, 500);
    showRecordingBanner();
    setPane("input");
  } catch (err) {
    toast("Microphone unavailable: " + (err && err.message ? err.message : err));
  }
}

function cancelRecording() {
  if (!state.recording) return;
  const recorder = state.mediaRecorder;
  state.recording = false;
  state.recordingChunks = [];
  state.recordingStartTime = 0;
  state.mediaRecorder = null;
  hideRecordingBanner();
  if (recorder && recorder.state !== "inactive") {
    try {
      recorder.stop();
    } catch (_) {
      /* already stopped */
    }
  }
}

async function stopAndSendRecording() {
  if (!state.recording || !state.mediaRecorder) return;
  const recorder = state.mediaRecorder;
  const mimeType = recorder.mimeType || "audio/ogg; codecs=opus";
  const chatId = state.activeChatId;

  state.recording = false;
  state.recordingStartTime = 0;
  state.mediaRecorder = null;
  hideRecordingBanner();

  await new Promise((resolve) => {
    const previous = recorder.onstop;
    recorder.onstop = () => {
      if (previous) previous();
      resolve();
    };
    try {
      recorder.stop();
    } catch (_) {
      resolve();
    }
  });

  const chunks = state.recordingChunks;
  state.recordingChunks = [];
  if (!chunks.length) {
    toast("No audio recorded");
    return;
  }
  const blob = new Blob(chunks, { type: mimeType });
  if (blob.size < 100) {
    toast("Recording too short");
    return;
  }

  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
    reader.onerror = () => reject(new Error("could not read recording"));
    reader.readAsDataURL(blob);
  });

  try {
    await invoke("bridge_send_audio", { chatId, audioData: base64, mimetype: mimeType });
    toast("Voice note sent");
    await refreshThread();
  } catch (err) {
    toast("Send failed: " + (err && err.message ? err.message : err));
  }
}

/* ---------------- composer modes (edit / reply) ---------------- */

function updateComposerBanner() {
  if (state.editingMessageId) {
    el.composerBanner.textContent = "✎ Editing message — Esc to cancel";
    el.composerBanner.classList.remove("hidden");
  } else if (state.replyToId) {
    el.composerBanner.textContent = "↩ Replying — Esc to cancel";
    el.composerBanner.classList.remove("hidden");
  } else {
    el.composerBanner.classList.add("hidden");
  }
}

function clearComposerMode() {
  state.editingMessageId = null;
  state.replyToId = null;
  updateComposerBanner();
}

function startReply(msg) {
  state.replyToId = msg.id;
  state.editingMessageId = null;
  updateComposerBanner();
  setPane("input");
}

function startEdit(msg) {
  state.editingMessageId = msg.id;
  state.replyToId = null;
  el.input.value = String(msg.body || "");
  autosize();
  updateComposerBanner();
  setPane("input");
}

async function send() {
  if (state.recording) return;
  const text = el.input.value.trim();
  const pending = state.pendingMedia.slice();
  if ((!text && pending.length === 0) || !state.activeChatId) return;
  const chatId = state.activeChatId;
  const replyTo = state.replyToId;

  // Images can't be applied as a text edit: pasting while editing sends a
  // new media message instead.
  const editing = pending.length > 0 ? null : state.editingMessageId;

  el.input.value = "";
  autosize();
  if (pending.length > 0) state.pendingMedia = [];
  renderPendingMedia();
  clearComposerMode();
  try {
    if (pending.length > 0) {
      state.sendingMedia = true;
      renderPendingMedia();
      for (let i = 0; i < pending.length; i++) {
        const item = pending[i];
        await invoke("bridge_send_media", {
          chatId,
          mediaData: item.data,
          mimetype: item.mimetype,
          filename: item.filename,
          // The typed text captions the first image; the rest go plain.
          caption: i === 0 ? text || null : null,
          quotedMessageId: i === 0 ? replyTo : null,
        });
      }
      state.sendingMedia = false;
      renderPendingMedia();
      await refreshThread();
    } else if (editing) {
      await invoke("bridge_edit_message", { chatId, messageId: editing, text });
      await refreshThread();
    } else {
      await invoke("bridge_send_message", { chatId, text, quotedMessageId: replyTo });
      await refreshThread();
    }
  } catch (err) {
    state.sendingMedia = false;
    renderPendingMedia();
    // Put the caption back so a failed send doesn't eat the typed text.
    // Images stay cleared (their bytes were already consumed); the user can
    // paste again.
    if (!el.input.value) {
      el.input.value = text;
      autosize();
    }
    toast("Send failed: " + (err && err.message ? err.message : err));
  }
}

async function deleteMessage(msg) {
  try {
    await invoke("bridge_delete_message", {
      chatId: state.activeChatId,
      messageId: msg.id,
      everyone: false,
    });
    refreshThread();
  } catch (err) {
    toast("Delete failed: " + (err && err.message ? err.message : err));
  }
}

async function reactTo(msg, emoji) {
  // Optimistic: reflect the toggle immediately. The bridge read-back is
  // laggy, but the reaction is actually sent to WhatsApp.
  const reactions = Array.isArray(msg.reactions) ? msg.reactions.slice() : [];
  const mine = reactions.findIndex((r) => r.by_me);
  if (mine >= 0 && reactions[mine].emoji === emoji) {
    reactions.splice(mine, 1);
  } else {
    if (mine >= 0) reactions.splice(mine, 1);
    reactions.push({ emoji, count: 1, by_me: true });
  }
  // Remember this so the poll (which returns empty reactions) can't wipe it.
  if (reactions.some((r) => r.by_me)) {
    state.localReactions.set(msg.id, reactions);
  } else {
    state.localReactions.delete(msg.id);
  }
  msg.reactions = reactions;
  renderMessages(false);
  try {
    await invoke("bridge_react_message", { messageId: msg.id, emoji });
    refreshThread();
  } catch (err) {
    toast("React failed: " + (err && err.message ? err.message : err));
    refreshThread();
  }
}

function copyText(msg) {
  const text = String(msg.body || "");
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } catch (_) {
    /* ignore */
  }
  ta.remove();
}

/* ---------------- pasted images (Cmd+V) ---------------- */

const PASTE_MAX_ITEMS = 5;
// Photo types WhatsApp renders as-is; anything else (macOS clipboard images can
// arrive as TIFF/BMP) is re-encoded before sending.
const PASTE_PASSTHROUGH_MIMETYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);
let pendingMediaKey = 0;

function guessExtension(mimetype, filename) {
  const fromName = String(filename || "").split(".").pop();
  if (fromName && /^[a-z0-9]{2,5}$/i.test(fromName) && String(filename).includes(".")) {
    return fromName.toLowerCase();
  }
  const type = String(mimetype || "").toLowerCase();
  if (type.includes("png")) return "png";
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  if (type.includes("gif")) return "gif";
  if (type.includes("webp")) return "webp";
  if (type.includes("mp4")) return "mp4";
  if (type.includes("quicktime")) return "mov";
  return "png";
}

function renderPendingMedia() {
  el.pendingMedia.replaceChildren();
  const items = state.pendingMedia;
  el.pendingMedia.classList.toggle("hidden", items.length === 0);
  el.pendingMedia.classList.toggle("pending-sending", state.sendingMedia);
  items.forEach((item) => {
    const wrap = document.createElement("div");
    wrap.className = "pending-item";
    const img = document.createElement("img");
    img.src = item.previewUrl;
    img.alt = item.filename;
    wrap.append(img);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "pending-remove";
    remove.textContent = "×";
    remove.title = "Remove image";
    remove.addEventListener("click", () => {
      state.pendingMedia = state.pendingMedia.filter((p) => p.key !== item.key);
      renderPendingMedia();
      el.input.focus();
    });
    wrap.append(remove);
    el.pendingMedia.append(wrap);
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read pasted image"));
    reader.readAsDataURL(file);
  });
}

/**
 * Re-encode a clipboard image through a canvas so the photo is a real PNG:
 * WhatsApp only renders the web image types, so a pasted TIFF/BMP would send
 * but never display. Keeps the original bytes when decoding fails.
 */
async function preparePastedImage({ dataUrl, data, mimetype, filename }) {
  if (PASTE_PASSTHROUGH_MIMETYPES.has(String(mimetype).toLowerCase())) {
    return { data, mimetype, filename, previewUrl: dataUrl };
  }

  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("could not decode pasted image"));
      img.src = dataUrl;
    });
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) throw new Error("pasted image has no pixels");
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(image, 0, 0);
    const pngDataUrl = canvas.toDataURL("image/png");
    return {
      data: pngDataUrl.slice(pngDataUrl.indexOf(",") + 1),
      mimetype: "image/png",
      filename: `${String(filename).replace(/\.[^.]+$/, "")}.png`,
      previewUrl: pngDataUrl,
    };
  } catch (_) {
    return { data, mimetype, filename, previewUrl: dataUrl };
  }
}

async function addPastedFiles(files) {
  const images = (Array.isArray(files) ? files : [...files]).filter(
    (f) => f && String(f.type || "").startsWith("image/"),
  );
  if (!images.length) {
    toast("Only images can be pasted for now");
    return;
  }
  if (!state.activeChatId) {
    toast("Open a chat first, then paste");
    return;
  }
  const room = PASTE_MAX_ITEMS - state.pendingMedia.length;
  if (room <= 0) {
    toast(`At most ${PASTE_MAX_ITEMS} images per message`);
    return;
  }
  // A paste while editing a text message starts a fresh media message.
  state.editingMessageId = null;
  updateComposerBanner();
  for (const file of images.slice(0, room)) {
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const comma = dataUrl.indexOf(",");
      if (comma < 0) continue;
      const header = dataUrl.slice(0, comma);
      const data = dataUrl.slice(comma + 1);
      const mimeMatch = header.match(/^data:([^;]+);base64$/);
      const mimetype = file.type || (mimeMatch && mimeMatch[1]) || "image/png";
      const ext = guessExtension(mimetype, file.name);
      const filename =
        (file.name && String(file.name).includes("."))
          ? file.name
          : `pasted-image-${Date.now()}.${ext}`;
      const prepared = await preparePastedImage({ dataUrl, data, mimetype, filename });
      state.pendingMedia.push({
        key: ++pendingMediaKey,
        mimetype: prepared.mimetype,
        data: prepared.data,
        filename: prepared.filename,
        previewUrl: prepared.previewUrl,
      });
    } catch (err) {
      toast("Paste failed: " + (err && err.message ? err.message : err));
    }
  }
  renderPendingMedia();
  setPane("input");
}

function collectImageFiles(dataTransfer) {
  if (!dataTransfer) return [];
  // Prefer clipboard items: `files` and `items` describe the same image in
  // most browsers, and using both would stage it twice.
  const viaItems = [];
  if (dataTransfer.items) {
    for (const item of dataTransfer.items) {
      if (item && item.kind === "file" && String(item.type || "").startsWith("image/")) {
        const file = typeof item.getAsFile === "function" ? item.getAsFile() : null;
        if (file) viaItems.push(file);
      }
    }
  }
  if (viaItems.length) return viaItems;
  if (dataTransfer.files) {
    return [...dataTransfer.files].filter(
      (f) => f && String(f.type || "").startsWith("image/"),
    );
  }
  return [];
}

document.addEventListener("paste", (event) => {
  if (document.activeElement === el.search) return;
  const files = collectImageFiles(event.clipboardData);
  if (!files.length) return; // plain text: let the default paste happen
  event.preventDefault();
  addPastedFiles(files);
});

el.composer.addEventListener("dragover", (event) => {
  if ([...((event.dataTransfer && event.dataTransfer.types) || [])].includes("Files")) {
    event.preventDefault();
  }
});
el.composer.addEventListener("drop", (event) => {
  const files = collectImageFiles(event.dataTransfer);
  if (!files.length) return;
  event.preventDefault();
  addPastedFiles(files);
});

/* ---------------- message menu ---------------- */

function buildMenuItems(msg) {
  if (state.menuConfirm) {
    return [
      { id: "delete-confirm", label: "🗑 Delete this message" },
      { id: "cancel", label: "Cancel" },
    ];
  }
  const items = [];
  if (isAudioType(msg)) items.push({ id: "play", label: "▶ Play voice note" });
  items.push({ id: "reply", label: "↩ Reply" });
  if (String(msg.body || "").trim()) items.push({ id: "copy", label: "⧉ Copy text" });
  if (msg.from_me && String(msg.body || "").trim()) items.push({ id: "edit", label: "✎ Edit" });
  if (msg.from_me) items.push({ id: "delete", label: "🗑 Delete" });
  items.push({ id: "react", label: "👍  React 👍", emoji: "👍" });
  items.push({ id: "react", label: "❤️  React ❤️", emoji: "❤️" });
  items.push({ id: "react", label: "😂  React 😂", emoji: "😂" });
  items.push({ id: "react", label: "🙏  React 🙏", emoji: "🙏" });
  return items;
}

function renderMenu() {
  el.msgMenu.replaceChildren();
  state.menuItems.forEach((item, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-item" + (i === state.menuIndex ? " sel" : "");
    btn.textContent = item.label;
    btn.addEventListener("click", () => {
      state.menuIndex = i;
      activateMenuItem(item);
    });
    el.msgMenu.append(btn);
  });
  el.msgMenu.classList.remove("hidden");
}

function openMenuForSelected() {
  const msg = state.messages.find((m) => m.id === state.selectedMsgId);
  if (!msg) return;
  state.menuMsg = msg;
  state.menuItems = buildMenuItems(msg);
  state.menuIndex = 0;
  state.menuConfirm = false;
  state.menuOpen = true;
  renderMenu();
}

function closeMenu() {
  state.menuOpen = false;
  state.menuConfirm = false;
  el.msgMenu.classList.add("hidden");
  if (state.pane === "messages") el.messages.focus();
}

async function activateMenuItem(item) {
  if (!item) return;
  const msg = state.menuMsg;
  switch (item.id) {
    case "play":
      closeMenu();
      playAudio(msg);
      break;
    case "reply":
      closeMenu();
      startReply(msg);
      break;
    case "copy":
      closeMenu();
      copyText(msg);
      break;
    case "edit":
      closeMenu();
      startEdit(msg);
      break;
    case "delete":
      state.menuConfirm = true;
      state.menuIndex = 0;
      state.menuItems = buildMenuItems(msg);
      renderMenu();
      break;
    case "delete-confirm":
      closeMenu();
      await deleteMessage(msg);
      break;
    case "cancel":
      closeMenu();
      break;
    case "react":
      closeMenu();
      reactTo(msg, item.emoji);
      break;
  }
}

function handleMenuKey(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeMenu();
    return;
  }
  if (event.key === "ArrowUp" || event.key === "k") {
    event.preventDefault();
    state.menuIndex = Math.max(0, state.menuIndex - 1);
    renderMenu();
    return;
  }
  if (event.key === "ArrowDown" || event.key === "j") {
    event.preventDefault();
    state.menuIndex = Math.min(state.menuItems.length - 1, state.menuIndex + 1);
    renderMenu();
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    activateMenuItem(state.menuItems[state.menuIndex]);
    return;
  }
}

/* ---------------- pane navigation ---------------- */

function setPane(pane) {
  state.pane = pane;
  if (pane === "input" || pane === "messages") state.threadPane = pane;
  el.shell.classList.remove("pane-chats", "pane-messages", "pane-input");
  el.shell.classList.add("pane-" + pane);
  if (pane === "chats") el.chatList.focus();
  else if (pane === "input") el.input.focus();
  else if (pane === "messages") el.messages.focus();
}

function currentMsgIndex() {
  return state.messages.findIndex((m) => m.id === state.selectedMsgId);
}

function enterMessages() {
  if (!state.messages.length) return; // nothing to focus, stay put
  const idx = currentMsgIndex();
  state.selectedMsgId =
    idx >= 0 ? state.messages[idx].id : state.messages[state.messages.length - 1].id;
  setPane("messages");
  updateMessageSelection();
  scrollMsgIntoView(1);
}

function selectMessage(delta) {
  if (!state.messages.length) return;
  const idx = currentMsgIndex();
  const base = idx < 0 ? state.messages.length - 1 : idx;
  const next = Math.min(state.messages.length - 1, Math.max(0, base + delta));
  state.selectedMsgId = state.messages[next].id;
  updateMessageSelection();
  scrollMsgIntoView(delta);
}

// Selection-only update: toggling the ring in place instead of rebuilding
// all 60 bubbles (which re-decoded every image and flashed on each ↑/↓).
function updateMessageSelection() {
  for (const node of el.messages.children) {
    if (node.dataset && node.dataset.messageId !== undefined) {
      node.classList.toggle("sel", node.dataset.messageId === state.selectedMsgId);
    }
  }
}

function scrollMsgIntoView(direction = 0) {
  if (!state.selectedMsgId) return;
  const node = el.messages.querySelector(
    `.msg[data-message-id="${CSS.escape(state.selectedMsgId)}"]`,
  );
  if (!node || !node.scrollIntoView) return;
  // `block: "nearest"` only scrolled the minimum, leaving tall images
  // half-shown. Moving down aligns the bottom so the whole message
  // (photo + caption + stamp) is visible; moving up aligns the top.
  // Already-fully-visible nodes are left alone to avoid jitter.
  const view = el.messages.getBoundingClientRect();
  const box = node.getBoundingClientRect();
  const fullyVisible = box.top >= view.top && box.bottom <= view.bottom;
  if (fullyVisible) return;
  node.scrollIntoView({ block: direction < 0 ? "start" : "end" });
}

function autosize() {
  el.input.style.height = "auto";
  el.input.style.height = `${Math.min(108, el.input.scrollHeight)}px`;
}

function moveSelection(delta) {
  if (!state.filtered.length) return;
  const next = Math.min(state.filtered.length - 1, Math.max(0, state.selected + delta));
  if (next === state.selected) return;
  state.selected = next;
  renderChats();
}

/* ---------------- keyboard ---------------- */

function isPrintable(event) {
  return event.key.length === 1 && !event.metaKey && !event.ctrlKey;
}

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "l") {
    // Toggle focus on search from anywhere (chats, thread, composer).
    event.preventDefault();
    if (document.activeElement === el.search) {
      el.search.blur();
      setPane("chats");
    } else {
      el.search.focus();
      el.search.select();
    }
    return;
  }
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "m") {
    // Toggle voice recording (start, or stop + send while recording).
    event.preventDefault();
    if (state.recording) stopAndSendRecording();
    else startRecording();
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (state.recording) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelRecording();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      stopAndSendRecording();
      return;
    }
  }

  if (state.menuOpen) {
    handleMenuKey(event);
    return;
  }

  const inSearch = document.activeElement === el.search;

  if (event.key === "Escape") {
    event.preventDefault();
    if (inSearch && state.filter) {
      el.search.value = "";
      state.filter = "";
      applyFilter();
      setPane("chats");
      return;
    }
    if (state.pendingMedia.length) {
      state.pendingMedia = [];
      renderPendingMedia();
      return;
    }
    if (state.editingMessageId || state.replyToId) {
      clearComposerMode();
      return;
    }
    if (state.pane === "messages") {
      setPane("input");
      return;
    }
    if (state.pane === "input") {
      setPane("chats");
      return;
    }
    invoke("hide_quick_cmd").catch(() => {});
    return;
  }

  if (event.key === "/" && !inSearch && state.pane !== "input") {
    event.preventDefault();
    el.search.focus();
    return;
  }

  if (inSearch) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const chat = state.filtered[state.selected];
      if (chat) openChat(chat.id);
      return;
    }
    return;
  }

  if (state.pane === "input") {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
      return;
    }
    if (event.key === "ArrowUp" && !el.input.value.includes("\n")) {
      event.preventDefault();
      enterMessages();
      return;
    }
    if (event.key === "ArrowDown" && !el.input.value.includes("\n")) {
      // Down from the composer does nothing.
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setPane("chats");
      return;
    }
    return;
  }

  if (state.pane === "messages") {
    if (event.key === "ArrowUp" || event.key === "k") {
      event.preventDefault();
      selectMessage(-1);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "j") {
      event.preventDefault();
      const idx = currentMsgIndex();
      if (idx >= state.messages.length - 1) {
        setPane("input");
      } else {
        selectMessage(1);
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setPane("chats");
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setPane("input");
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const msg = state.messages.find((m) => m.id === state.selectedMsgId);
      performPrimaryAction(msg);
      return;
    }
    if (event.key === "m") {
      event.preventDefault();
      openMenuForSelected();
      return;
    }
    return;
  }

  // chats pane
  if (isPrintable(event)) {
    el.search.focus();
    el.search.value = event.key;
    state.filter = el.search.value;
    applyFilter();
    event.preventDefault();
    return;
  }
  if (event.key === "ArrowDown" || event.key === "j") {
    event.preventDefault();
    moveSelection(1);
    return;
  }
  if (event.key === "ArrowUp" || event.key === "k") {
    event.preventDefault();
    moveSelection(-1);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    const chat = state.filtered[state.selected];
    if (chat) openChat(chat.id);
    return;
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    if (state.activeChatId) {
      // Return to whichever right-side pane we came from (composer or messages).
      if (state.threadPane === "messages" && state.messages.length) {
        enterMessages();
      } else {
        setPane("input");
      }
    }
    return;
  }
});

el.search.addEventListener("input", () => {
  state.filter = el.search.value;
  state.selected = 0;
  applyFilter();
});

el.search.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    el.search.value = "";
    state.filter = "";
    applyFilter();
    setPane("chats");
  }
});

el.chatList.addEventListener("click", (event) => {
  const row = event.target.closest(".row");
  if (!row) return;
  const index = state.filtered.findIndex((c) => c.id === row.dataset.chatId);
  if (index >= 0) state.selected = index;
  openChat(row.dataset.chatId);
});

el.messages.addEventListener("click", (event) => {
  const node = event.target.closest(".msg");
  if (!node || !node.dataset.messageId) return;
  state.selectedMsgId = node.dataset.messageId;
  state.pane = "messages";
  updateMessageSelection();
});

el.messages.addEventListener("scroll", () => {
  // Any upward movement is the user taking over: kill the open-chat pin
  // at once. Programmatic scrolls only ever go down (to the bottom), so
  // a decrease can only be the user. The old "120px from bottom" check
  // alone meant small scroll-ups never cleared the pin, and every image
  // still loading yanked the view back down (blink, no movement).
  const top = el.messages.scrollTop;
  if (top < lastMsgTop - 2 || !isNearBottom(120)) state.pinBottom = false;
  lastMsgTop = top;
});

el.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  send();
});

el.input.addEventListener("focus", () => {
  state.pane = "input";
});

el.input.addEventListener("input", autosize);

el.mic.addEventListener("click", () => {
  if (state.recording) stopAndSendRecording();
  else startRecording();
});

/* ---------------- lifecycle ---------------- */

function tick() {
  if (document.hidden) return;
  const now = Date.now();
  if (now - state.lastChatsAt > CHATS_POLL_MS) refreshChats();
  if (state.activeChatId && now - state.lastThreadAt > THREAD_POLL_MS) refreshThread();
}

function restoreSession() {
  if (!state.activeChatId) {
    setPane("chats");
    return;
  }
  const idx = state.filtered.findIndex((c) => c.id === state.activeChatId);
  if (idx >= 0) state.selected = idx;
  renderChats();
  refreshThread();
  // Keep the draft and put the caret back in the composer.
  setPane("input");
  const len = el.input.value.length;
  try {
    el.input.setSelectionRange(len, len);
  } catch (_) {
    /* ignore */
  }
  autosize();
}

/// Hard reset any document scroll. While the card is parked below the fold,
/// a scrollIntoView()/focus() inside it (chat select, composer, search) can
/// scroll the document and leave the whole card shifted up — which is what
/// makes the card look misplaced and clip its own search bar.
function resetDocScroll() {
  const se = document.scrollingElement || document.documentElement;
  if (se) {
    se.scrollTop = 0;
    se.scrollLeft = 0;
  }
  document.documentElement.scrollTop = 0;
  document.documentElement.scrollLeft = 0;
  document.body.scrollTop = 0;
  document.body.scrollLeft = 0;
}

function debugViewport(tag) {
  const shell = document.querySelector(".shell");
  const r = shell ? shell.getBoundingClientRect() : null;
  const cs = shell ? getComputedStyle(shell) : null;
  const msg =
    `[quick] ${tag} viewport=${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio} ` +
    `body=${document.body.clientWidth}x${document.body.clientHeight} ` +
    `pre-spawn=${document.body.classList.contains("pre-spawn")} ` +
    `shell=${r ? `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)}` : "-"} ` +
    `transform=${cs ? cs.transform : "-"} opacity=${cs ? cs.opacity : "-"} ` +
    `vis=${document.visibilityState} hidden=${document.hidden}`;
  invoke("log_debug", { message: msg }).catch(() => {});
}

async function boot() {
  // The window starts hidden with the card parked below the fold (the
  // pre-spawn class ships in the HTML, so even the very first painted frame
  // is the parked card). Register the slide listeners BEFORE any network
  // await: a toggle in the first seconds must not be missed.
  if (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen) {
    const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.__TAURI__.event.listen("quick-shown", () => {
      // ytm's rule, copied verbatim: never cancel() the card's animations.
      // Cancelling a mid-flight slide-out (rapid off->on inside the 260ms
      // window) snaps the card and reads as a flash; CSS transitions reverse
      // smoothly on their own, so an interrupted slide-out just eases back
      // in. Only force a reflow when NO transition is running (cold show) so
      // the parked state commits and exactly one transition fires.
      const shell = document.querySelector(".shell");
      if (shell && document.body.classList.contains("pre-spawn")) {
        if (!REDUCED) {
          let running = false;
          try {
            running = shell.getAnimations().length > 0;
          } catch (_) {
            /* getAnimations unsupported: fall through to the flush */
          }
          if (!running) {
            shell.style.transition = "";
            shell.style.transform = "";
            void shell.offsetWidth; // flush: commit the parked frame
          }
        }
        document.body.classList.remove("pre-spawn");
        resetDocScroll();
      }
      ensureBridge().then(() => refreshChats());
      restoreSession();
      resetDocScroll();
      debugViewport("shown");
      // A window that was hidden since launch can show with a stale/empty
      // layer; re-check a beat later in case the first paint never landed.
      setTimeout(() => debugViewport("shown+400ms"), 400);
    });
    window.__TAURI__.event.listen("quick-hiding", () => {
      // Park the card. Never cancel animations here either.
      document.body.classList.add("pre-spawn");
      debugViewport("hiding");
    });
  }
  renderThreadHead(null);
  // Show the real bundle version so the running build is identifiable.
  try {
    const v = await window.__TAURI__.app.getVersion();
    const el = document.getElementById("build-version");
    if (el && v) el.textContent = `v${v}`;
  } catch (_) {
    /* ignore */
  }
  await ensureBridge();
  await refreshChats();
  el.chatList.setAttribute("tabindex", "0");
  el.messages.setAttribute("tabindex", "0");
  setPane("chats");

  setInterval(tick, 1500);
  setTimeout(() => refreshChats(), 600);
}

boot();
