const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../ui/quick.js'), 'utf8');
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `missing section: ${start}`);
  return source.slice(first, last);
}

function setup() {
  const calls = [];
  const messages = [
    { id: 'incoming', type: 'ptt', from_me: false, body: '' },
    { id: 'sent', type: 'chat', from_me: true, body: 'hello' },
    { id: 'next', type: 'chat', from_me: false, body: 'next' },
  ];
  const state = {
    messages, selectedMsgId: 'incoming', activeChatId: 'chat', pane: 'messages',
    menuOpen: false, menuConfirm: false, menuItems: [], localReactions: new Map(),
    deletedPlaceholders: new Map(),
    playingId: null, audioRequestId: 0, recording: false,
  };
  const buttons = [];
  const menu = {
    classList: { add() {}, remove() {} },
    replaceChildren() { buttons.length = 0; },
    append(button) { buttons.push(button); },
  };
  const el = {
    msgMenu: menu, messages: { focus() {} }, search: {},
    messagesInner: {},
  };
  const document = {
    activeElement: {},
    createElement() { return { addEventListener() {} }; },
    addEventListener(name, listener) { if (name === 'keydown') this.onKeydown = listener; },
  };
  let rejection = null;
  const context = {
    state, el, document,
    isAudioType: (msg) => msg.type === 'ptt' || msg.type === 'audio',
    invoke: async (name, args) => { calls.push([name, args]); if (rejection) throw rejection; },
    refreshThread: () => { calls.push(['refresh']); },
    renderMessages: () => { calls.push(['render']); },
    stopAudioPlayback: () => { calls.push(['stop']); },
    toast: (text) => { calls.push(['toast', text]); },
    playAudio: (msg) => { calls.push(['play', msg.id]); },
    primaryMessageUrl: (msg) => msg.url || '',
    hasOpenableMedia: (msg) => !!msg.has_media,
    mediaLabel: (msg) => msg.type,
    openLink: (url) => { calls.push(['open-link', url]); },
    openMediaExternally: (msg) => { calls.push(['open-media', msg.id]); },
  };
  vm.createContext(context);
  vm.runInContext(
    section('async function deleteMessage(msg)', 'async function reactTo(msg, emoji)') +
    section('function performPrimaryAction(msg)', '/** Render a chat body') +
    section('function buildMenuItems(msg)', '/* ---------------- pane navigation ---------------- */') +
    section('document.addEventListener("keydown",', '\n\nel.search.addEventListener'),
    context,
  );
  const press = (key, target = '', extra = {}) => {
    let prevented = false;
    document.onKeydown({ key, metaKey: false, ctrlKey: false, altKey: false,
      shiftKey: false, repeat: false, ...extra,
      target: { matches: (selector) => selector.split(', ').includes(target) },
      preventDefault() { prevented = true; } });
    return prevented;
  };
  return { context, state, calls, buttons, press, setRejection: (err) => { rejection = err; } };
}

test('polling an older shared bridge cannot erase a local deleted placeholder', () => {
  const state = { deletedPlaceholders: new Map([['chat', [
    { id: 'deleted', type: 'deleted', timestamp: 20, from_me: false, body: '' },
  ]]]) };
  const context = { state };
  vm.createContext(context);
  vm.runInContext(section('function mergeLocalDeletedMessages(', 'async function refreshThread()'), context);
  const messages = [{ id: 'before', timestamp: 10 },
    { id: 'deleted', timestamp: 20, body: 'old content' },
    { id: 'after', timestamp: 30 }];
  const merged = context.mergeLocalDeletedMessages('chat', messages);
  assert.deepEqual(Array.from(merged, (m) => m.id), ['before', 'deleted', 'after']);
  assert.equal(merged[1].type, 'deleted');
  assert.equal(merged[1].body, '');
});

test('deleted message renders as a non-interactive bubble with its original timestamp', () => {
  const nodes = [];
  const document = {
    createDocumentFragment: () => ({ append(node) { nodes.push(node); } }),
    createElement: () => ({ dataset: {}, classList: { add(name) { this[name] = true; } },
      append(child) { this.child = child; } }),
  };
  const state = { chats: [], activeChatId: 'chat', selectedMsgId: 'deleted',
    messages: [{ id: 'deleted', type: 'deleted', timestamp: 42, from_me: true, body: '' }] };
  const context = { document, state,
    el: { messagesInner: { replaceChildren() {} } },
    fmtTime: () => '12:34', updateAudioPlaybackUI() {},
  };
  vm.createContext(context);
  vm.runInContext(section('function renderMessages(scrollToEnd)', 'function scrollToBottom()'), context);
  context.renderMessages(false);
  assert.equal(nodes.length, 1);
  assert.match(nodes[0].className, /msg out.* sel/);
  assert.equal(nodes[0].textContent, 'This message was deleted');
  assert.equal(nodes[0].child.textContent, '12:34');
  assert.equal(nodes[0].classList.deleted, true);
});

test('Enter on audio opens standard menu; Space toggles playback without scrolling or repeating', () => {
  const { state, calls, press } = setup();
  assert.equal(press('Enter'), true);
  assert.equal(state.menuOpen, true);
  assert.ok(state.menuItems.some((item) => item.id === 'reply'));
  assert.ok(state.menuItems.some((item) => item.id === 'react'));
  assert.ok(state.menuItems.some((item) => item.id === 'delete'));
  assert.ok(!calls.some(([name]) => name === 'play'));
  assert.equal(press('Escape'), true);
  assert.equal(press(' '), true);
  assert.equal(press(' '), true);
  assert.equal(press(' ', '', { repeat: true }), true);
  assert.deepEqual(calls.filter(([name]) => name === 'play').map(([, id]) => id), ['incoming', 'incoming']);
  assert.equal(press(' ', '.audio-toggle'), false);
  assert.equal(press(' ', '.audio-progress'), false);
  assert.equal(press(' ', '.audio-speed'), false);
  state.selectedMsgId = 'sent';
  assert.equal(press(' '), false);
});

test('Enter on links and images opens actions; Open remains selectable alongside reply and react', async () => {
  const { state, calls, press } = setup();
  const link = { id: 'link', type: 'chat', body: 'https://example.com', url: 'https://example.com' };
  const image = { id: 'image', type: 'image', body: '', has_media: true };
  state.messages.push(link, image);
  for (const [msg, action, expected] of [
    [link, 'open-link', 'https://example.com'],
    [image, 'open-media', 'image'],
  ]) {
    state.selectedMsgId = msg.id;
    assert.equal(press('Enter'), true);
    assert.equal(state.menuOpen, true);
    assert.equal(state.menuItems[0].id, action);
    assert.ok(state.menuItems.some((item) => item.id === 'reply'));
    assert.ok(state.menuItems.some((item) => item.id === 'react'));
    assert.ok(!calls.some(([name]) => name === action));
    assert.equal(press('Enter'), true);
    assert.equal(state.menuOpen, false);
    assert.deepEqual(calls.at(-1), [action, expected]);
  }
});

test('delete for me is offered on incoming and outgoing messages and requires confirmation', async () => {
  const { context, state, calls, press } = setup();
  for (const id of ['incoming', 'sent']) {
    state.selectedMsgId = id;
    context.openMenuForSelected();
    const item = state.menuItems.find((entry) => entry.id === 'delete');
    assert.equal(item.label, '🗑 Delete for me');
    await context.activateMenuItem(item);
    assert.equal(state.menuConfirm, true);
    assert.equal(state.menuItems[0].id, 'delete-confirm');
    assert.equal(state.menuItems[1].id, 'cancel');
    assert.equal(press('Escape'), true);
    assert.equal(state.menuOpen, false);
  }
  assert.equal(calls.length, 0);
  state.selectedMsgId = 'incoming';
  context.openMenuForSelected();
  await context.activateMenuItem(state.menuItems.find((item) => item.id === 'delete'));
  await context.activateMenuItem(state.menuItems[0]);
  assert.equal(calls[0][0], 'bridge_delete_message');
  assert.deepEqual({ ...calls[0][1] }, {
    chatId: 'chat', messageId: 'incoming', everyone: false,
  });
  assert.deepEqual(state.messages.map((m) => m.id), ['incoming', 'sent', 'next']);
  assert.equal(state.messages[0].type, 'deleted');
  assert.equal(state.messages[0].body, '');
  assert.equal(state.deletedPlaceholders.get('chat')[0].id, 'incoming');
  assert.equal(state.selectedMsgId, 'incoming');
  context.openMenuForSelected();
  assert.equal(state.menuOpen, false);
  assert.deepEqual(calls.slice(1).map(([name]) => name), ['render', 'refresh']);
  assert.equal(state.menuOpen, false);
});

test('delete failure retains message and selection and reports error', async () => {
  const { context, state, calls, setRejection } = setup();
  setRejection(new Error('offline'));
  context.openMenuForSelected();
  await context.activateMenuItem(state.menuItems.find((item) => item.id === 'delete'));
  await context.activateMenuItem(state.menuItems[0]);
  assert.equal(state.messages.length, 3);
  assert.equal(state.selectedMsgId, 'incoming');
  assert.deepEqual(calls.map(([name]) => name), ['bridge_delete_message', 'toast']);
  assert.match(calls[1][1], /Delete failed: offline/);
});

test('deleting playing audio stops it and deleting last message keeps a placeholder', async () => {
  const { context, state, calls } = setup();
  state.playingId = 'incoming';
  await context.deleteMessage(state.messages[0]);
  assert.ok(calls.some(([name]) => name === 'stop'));
  assert.equal(state.audioRequestId, 1);
  state.selectedMsgId = 'next';
  await context.deleteMessage(state.messages[2]);
  assert.equal(state.selectedMsgId, 'next');
  assert.equal(state.messages[2].type, 'deleted');
});
