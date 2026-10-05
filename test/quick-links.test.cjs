const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { test } = require('node:test');

const ui = fs.readFileSync(path.join(__dirname, '../ui/quick.js'), 'utf8');
const safari = fs.readFileSync(path.join(__dirname, '../scripts/whatsapp-quick-safari.user.js'), 'utf8');

function uiContext() {
  const start = ui.indexOf('function parseQuickLink(');
  const end = ui.indexOf('/* ---------------- bridge ---------------- */', start);
  assert.ok(start > 0 && end > start);
  const calls = [];
  const state = { chats: [], linkChat: null };
  const el = { input: { value: '' } };
  const context = { URL, state, el, applyFilter() {}, openChat: async (id) => calls.push(id),
    invoke: async (command) => { assert.equal(command, 'show_quick_cmd'); },
    autosize() {}, updateSidebarModeUI() {}, refreshChats: async () => {},
    setPane: (pane) => calls.push(pane), toast: (text) => calls.push(text) };
  vm.createContext(context);
  vm.runInContext(ui.slice(start, end) + '\nquickLinkReady = true;', context);
  return { context, state, el, calls };
}

test('Quick accepts only its own valid number links and never sends', async () => {
  const { context, state, el, calls } = uiContext();
  await context.acceptQuickLink('whatsapp-quick://send?phone=5493511234567&text=Hola%20%26%20chau');
  assert.equal(state.linkChat.id, '5493511234567@c.us');
  assert.equal(el.input.value, 'Hola & chau');
  assert.deepEqual(calls, ['5493511234567@c.us', 'input']);
  await context.acceptQuickLink('whatsapp-quick://send?phone=5493511234567');
  assert.equal(el.input.value, 'Hola & chau');
  for (const invalid of ['whatsapp://send?phone=5493511234567',
    'whatsapp-quick://evil?phone=5493511234567', 'whatsapp-quick://send?phone=123',
    'whatsapp-quick://send?phone=549+3511234567']) {
    assert.equal(context.parseQuickLink(invalid), null);
  }
});

test('notification links open direct, group and LID chats without sending or overwriting drafts', async () => {
  const { context, state, el, calls } = uiContext();
  el.input.value = 'Unsent draft';
  for (const id of ['123@c.us', '123-456@g.us', '123@lid']) {
    await context.acceptQuickLink(`whatsapp-quick://chat?id=${encodeURIComponent(id)}`);
    assert.equal(state.linkChat.id, id);
    assert.equal(state.groupMode, id.endsWith('@g.us'));
    assert.equal(el.input.value, 'Unsent draft');
  }
  assert.deepEqual(calls, ['123@c.us', 'input', '123-456@g.us', 'input', '123@lid', 'input']);
  for (const id of ['status@broadcast', '@c.us', '../path@c.us', '1@evil']) {
    assert.equal(context.parseQuickLink(`whatsapp-quick://chat?id=${encodeURIComponent(id)}`), null);
  }
});

function safariContext(href = 'https://example.com/') {
  const handlers = {};
  const assigned = [];
  const links = [];
  const document = {
    readyState: 'loading',
    addEventListener(name, handler) { handlers[name] = handler; },
    createElement() { return { style: {} }; },
    body: { append(link) { links.push(link); } },
  };
  const location = { href, assign(value) { assigned.push(value); } };
  const context = { URL, document, location };
  vm.createContext(context);
  vm.runInContext(safari, context);
  return { handlers, assigned, links }; 
}

test('Safari intercepts supported clicks, preserving URL-encoded draft', () => {
  const { handlers, assigned } = safariContext();
  let prevented = false;
  handlers.click({ button: 0, defaultPrevented: false, metaKey: false, ctrlKey: false,
    shiftKey: false, altKey: false, preventDefault() { prevented = true; },
    target: { closest() { return { href: 'https://wa.me/5493511234567?text=Hola%20%26%20chau', hasAttribute() { return false; } }; } } });
  assert.equal(prevented, true);
  assert.equal(assigned[0], 'whatsapp-quick://send?phone=5493511234567&text=Hola+%26+chau');
});

test('Safari leaves unsupported links and modified clicks alone; direct visit offers fallback', () => {
  const { handlers, assigned, links } = safariContext('https://api.whatsapp.com/send?phone=5493511234567&text=Hi');
  assert.equal(assigned[0], 'whatsapp-quick://send?phone=5493511234567&text=Hi');
  handlers.DOMContentLoaded();
  assert.equal(links[0].href, assigned[0]);
  assert.equal(links[0].textContent, 'Open in WhatsApp Quick');
  const other = safariContext();
  const clicked = [];
  for (const [href, modified] of [['https://wa.me/message/abc', false],
    ['https://wa.me/5493511234567', true]]) {
    other.handlers.click({ button: 0, defaultPrevented: false, metaKey: modified,
      ctrlKey: false, shiftKey: false, altKey: false, preventDefault() { clicked.push(href); },
      target: { closest() { return { href, hasAttribute() { return false; } }; } } });
  }
  assert.deepEqual(clicked, []);
  assert.deepEqual(other.assigned, []);
});
