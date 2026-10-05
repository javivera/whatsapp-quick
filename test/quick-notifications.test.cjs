const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const bridge = fs.readFileSync(path.join(__dirname, '../bridge_server.js'), 'utf8');

function setup() {
  const start = bridge.indexOf('const NOTIFICATION_EPOCH =');
  const end = bridge.indexOf('// Background refresh', start);
  assert.ok(start > 0 && end > start);
  let response;
  const state = { ready: true, authorNames: new Map() };
  const context = { state, require, Date, console: { warn() {} },
    chatUpdateId: (msg) => msg.id._serialized,
    isHiddenSystemNotification: (msg) => Boolean(msg.isNotification),
    PUPPETEER_OP_TIMEOUT_MS: 100,
    client: { pupPage: { evaluate: async (fn, id) => fn(id) } },
    window: { Store: { Chat: { get: () => null }, WidFactory: { createWid: (id) => id } } },
    withTimeout: async (fn) => fn(),
    json: (_res, status, body) => { response = { status, body }; },
  };
  vm.createContext(context);
  vm.runInContext(bridge.slice(start, end), context);
  const read = (epoch, after) => {
    const url = new URL('http://localhost/notification-events');
    if (epoch !== undefined) url.searchParams.set('epoch', epoch);
    if (after !== undefined) url.searchParams.set('after', after);
    context.handleNotificationEvents(url, {});
    return response.body;
  };
  return { context, state, read };
}

function message(overrides = {}) {
  return { id: { _serialized: 'incoming-1', remote: '123@c.us' },
    fromMe: false, timestamp: Math.floor(Date.now() / 1000), type: 'chat', body: 'Hi there',
    getChat: async () => ({ name: 'Contact', isMuted: false, archived: false }), ...overrides };
}

test('feed baselines, preserves each live message, and deduplicates repeated events', async () => {
  const { context, read } = setup();
  const baseline = read();
  await context.queueIncomingNotification(message());
  await context.queueIncomingNotification(message());
  await context.queueIncomingNotification(message({ id: { _serialized: 'incoming-2', remote: '123@c.us' }, body: 'Second' }));
  const next = read(baseline.epoch, baseline.cursor);
  assert.equal(next.events.length, 2);
  assert.equal(next.events[0].title, 'Contact');
  assert.equal(next.events[0].body, 'Hi there');
  assert.equal(next.events[1].body, 'Second');
  assert.equal(read(next.epoch, next.cursor).events.length, 0);
  assert.equal(read().events.length, 0);
  assert.equal(read('previous-process', 0).events.length, 0);
  assert.equal(read(next.epoch, 'not-a-number').events.length, 0);
});

test('own, muted, archived, stale, broadcast and system messages never alert', async () => {
  const { context, read, state } = setup();
  const baseline = read();
  const skips = [
    { fromMe: true }, { isNotification: true }, { type: 'revoked' }, { type: 'call_log' },
    { timestamp: Math.floor(Date.now() / 1000) - 121 },
    { id: { _serialized: 'status', remote: 'status@broadcast' } },
    { getChat: async () => ({ isMuted: true }) },
    { getChat: async () => ({ isMuted: false, archived: true }) },
    { getChat: async () => ({}) }, // Unknown mute state: fail closed.
    { getChat: async () => { throw new Error('offline'); } },
  ];
  for (let i = 0; i < skips.length; i++) {
    await context.queueIncomingNotification(message({ id: { _serialized: `skip-${i}`, remote: '123@c.us' }, ...skips[i] }));
  }
  state.ready = false;
  await context.queueIncomingNotification(message());
  assert.equal(read(baseline.epoch, baseline.cursor).events.length, 0);
});

test('media previews hide encoded data and groups include sender name', async () => {
  const { context, read } = setup();
  const baseline = read();
  assert.equal(context.notificationPreview(message({ type: 'ptt', body: 'BASE64' })), 'Voice message');
  assert.equal(context.notificationPreview(message({ type: 'image', body: 'BASE64' })), 'Photo');
  assert.equal(context.notificationPreview(message({ body: 'one\n two' })), 'one two');
  assert.equal(context.notificationPreview(message({ body: 'a'.repeat(500) })).length, 240);
  await context.queueIncomingNotification(message({
    id: { _serialized: 'group-1', remote: '123-456@g.us' }, notifyName: 'Sender',
    getChat: async () => ({ name: 'Group', isMuted: false }),
  }));
  const event = read(baseline.epoch, 0).events[0];
  assert.equal(event.title, 'Group');
  assert.equal(event.subtitle, 'Sender');
  assert.equal(event.chat_id, '123-456@g.us');
});

test('broken getChat uses raw Store mute state without fetching or marking seen', async () => {
  const { context, read } = setup();
  const baseline = read();
  let expiration = 0;
  context.window.Store.Chat.get = () => ({ formattedTitle: 'Store contact', archive: false, mute: { expiration } });
  const broken = { getChat: async () => { throw new Error('r'); } };
  await context.queueIncomingNotification(message({ ...broken, id: { _serialized: 'store-1', remote: '123@c.us' } }));
  const feed = read(baseline.epoch, 0);
  assert.equal(feed.events.length, 1);
  assert.equal(feed.events[0].title, 'Store contact');
  expiration = -1;
  await context.queueIncomingNotification(message({ ...broken, id: { _serialized: 'store-2', remote: '123@c.us' } }));
  expiration = Date.now() / 1000 + 3600;
  await context.queueIncomingNotification(message({ ...broken, id: { _serialized: 'store-3', remote: '123@c.us' } }));
  assert.equal(read(baseline.epoch, 0).events.length, 1);
});

test('live queue and dedup history stay bounded', async () => {
  const { context, read } = setup();
  const baseline = read();
  for (let i = 0; i < 2100; i++) {
    await context.queueIncomingNotification(message({ id: { _serialized: `live-${i}`, remote: '123@c.us' } }));
  }
  const feed = read(baseline.epoch, 0);
  assert.equal(feed.cursor, 2100);
  assert.equal(feed.events.length, 500);
  assert.equal(vm.runInContext('NOTIFICATION_SEEN_IDS.size', context), 2000);
});
