const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const ui = fs.readFileSync(path.join(__dirname, '../ui/quick.js'), 'utf8');

function previewFor(lastMessage) {
  function element() {
    return {
      children: [], dataset: {}, style: {}, className: '', textContent: '',
      classList: { add() {}, toggle() {} },
      setAttribute() {},
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren(...nodes) { this.children = nodes.flatMap(node => node.children || [node]); },
    };
  }
  const chatList = element();
  const document = { createElement: element, createDocumentFragment: element };
  const chat = { id: 'test@c.us', name: 'Test', last_message: lastMessage };
  const state = { filtered: [chat], selected: 0, profilePics: new Map([[chat.id, 'fetching']]) };
  const context = { document, state, el: { chatList, chatsEmpty: element() }, fmtTime: () => '' };
  vm.createContext(context);
  vm.runInContext(
    ui.slice(ui.indexOf('function initials('), ui.indexOf('async function ensureProfilePic(')) +
    ui.slice(ui.indexOf('function renderChats()'), ui.indexOf('function renderThreadHead(')), context);
  context.renderChats();
  return chatList.children[0].children[1].children[1].children[0].textContent;
}

test('incoming and outgoing photos show a camera icon, never encoded image data', () => {
  const body = '/9j/4AAQSkZJRgABAQAAAQABAAD/...';
  assert.equal(previewFor({ type: 'image', body, from_me: false }), '📷 Photo');
  assert.equal(previewFor({ type: 'image', body, from_me: true }), 'You: 📷 Photo');
  assert.equal(previewFor({ type: 'sticker', body, from_me: false }), '📷 Photo');
});

test('incoming and outgoing voice messages show a microphone icon, never encoded audio data', () => {
  const body = 'T2dnUwACAAAAAAAAAAD/...';
  assert.equal(previewFor({ type: 'ptt', body, from_me: false }), '🎤 Voice message');
  assert.equal(previewFor({ type: 'ptt', body, from_me: true }), 'You: 🎤 Voice message');
  assert.equal(previewFor({ type: 'audio', body, from_me: false }), '🎤 Voice message');
});

test('ordinary messages retain their text and outgoing prefix', () => {
  assert.equal(previewFor({ type: 'chat', body: 'Hello', from_me: false }), 'Hello');
  assert.equal(previewFor({ type: 'chat', body: 'Hello', from_me: true }), 'You: Hello');
  assert.equal(previewFor({ type: 'video', body: '', from_me: false }), '[video]');
});
