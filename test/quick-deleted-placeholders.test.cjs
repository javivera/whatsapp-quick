const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../bridge_server.js'), 'utf8');
const start = source.indexOf('function loadDeletedPlaceholders()');
const end = source.indexOf('let shutdownPromise = null;', start);
assert.ok(start > 0 && end > start);

function setup(file) {
  const state = { deletedPlaceholders: new Map() };
  const context = { fs, state, DELETED_MESSAGES_PATH: file, MESSAGES_CACHE_LIMIT: 1000,
    console: { warn() {} } };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return { context, state };
}

test('delete response keeps the original timestamp even after the bridge refresh removes the message', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-delete-response-'));
  try {
    const file = path.join(dir, 'deleted.json');
    const { context, state } = setup(file);
    state.ready = true;
    state.messagesCache = new Map([['chat', { messages: [
      { id: 'target', type: 'chat', timestamp: 42, from_me: true, body: 'private text' },
    ] }]]);
    let response;
    Object.assign(context, {
      client: {}, PUPPETEER_OP_TIMEOUT_MS: 1000,
      readJsonBody: async () => ({ chat_id: 'chat', message_id: 'target', everyone: false }),
      withTimeout: (fn) => fn(),
      deleteMessageForMeCompat: async () => {},
      queueMessagesFetch: async () => { state.messagesCache.get('chat').messages = []; },
      refreshChatsFromPuppeteer: async () => {},
      json: (_res, status, payload) => { response = { status, payload }; },
    });
    const handlerStart = source.indexOf('async function handleDeleteMessage(');
    const handlerEnd = source.indexOf('/**\n * New endpoint: POST /refresh', handlerStart);
    vm.runInContext(source.slice(handlerStart, handlerEnd), context);
    await context.handleDeleteMessage({}, {});
    assert.equal(response.status, 200);
    const [placeholder] = state.messagesCache.get('chat').messages;
    assert.equal(placeholder.type, 'deleted');
    assert.equal(placeholder.timestamp, 42);
    assert.equal(placeholder.from_me, true);
    assert.ok(!fs.readFileSync(file, 'utf8').includes('private text'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deleted placeholders persist without message content and survive a stale fetch and restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-tombstones-'));
  try {
    const file = path.join(dir, 'deleted.json');
    const { context, state } = setup(file);
    state.deletedPlaceholders.set('chat', [
      { id: 'deleted', type: 'deleted', timestamp: 20, from_me: false, body: '' },
    ]);
    context.saveDeletedPlaceholders();
    const persisted = fs.readFileSync(file, 'utf8');
    assert.ok(!persisted.includes('secret message'));
    assert.deepEqual(JSON.parse(persisted), [
      { chat_id: 'chat', id: 'deleted', timestamp: 20, from_me: false },
    ]);
    const restarted = setup(file);
    const fresh = [
      { id: 'before', timestamp: 10, body: 'before' },
      { id: 'deleted', timestamp: 20, body: 'secret message' },
      { id: 'after', timestamp: 30, body: 'after' },
    ];
    const merged = restarted.context.mergeDeletedPlaceholders('chat', fresh);
    assert.deepEqual(Array.from(merged, (m) => m.id), ['before', 'deleted', 'after']);
    assert.equal(merged[1].type, 'deleted');
    assert.equal(merged[1].body, '');
    assert.equal(fresh[1].body, 'secret message');
    assert.equal(restarted.context.mergeDeletedPlaceholders('other', fresh), fresh);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
