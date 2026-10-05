const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../bridge_server.js'), 'utf8');
const start = source.indexOf('async function deleteMessageForMeCompat(');
const end = source.indexOf('async function handleDeleteMessage(', start);
assert.ok(start > 0 && end > start);

function setup(version = '2.3000.0') {
  const sent = [];
  const msg = { id: { $1: 'false_chat_abc' } };
  const chat = { msgs: { getModelsArray: () => [msg] } };
  const window = {
    Debug: { VERSION: version },
    WWebJS: { compareWwebVersions: (current) => current === '2.3000.0' },
    require(name) {
      return {
        WAWebCollections: { Chat: { get: (id) => id === 'chat' ? chat : null } },
        WAWebWidFactory: { createWid: (id) => id },
        WAWebCmd: { Cmd: { sendDeleteMsgs: async (...args) => { sent.push(args); } } },
      }[name];
    },
  };
  const context = { client: { pupPage: { evaluate: (fn, ...args) => fn(...args) } }, window };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return { context, sent, msg, chat };
}

test('local delete uses the loaded Store message, without broken getMessageById or revoke capability', async () => {
  const { context, sent, msg, chat } = setup();
  await context.deleteMessageForMeCompat('chat', 'false_chat_abc');
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], chat);
  assert.equal(sent[0][1].list[0], msg);
  assert.equal(sent[0][1].type, 'message');
  assert.equal(sent[0][2], true);
});

test('older WhatsApp Web delete signature and wrong-chat protection', async () => {
  const { context, sent, msg, chat } = setup('2.2000.0');
  await context.deleteMessageForMeCompat('chat', 'false_chat_abc');
  assert.equal(sent[0][0], chat);
  assert.equal(sent[0][1][0], msg);
  await assert.rejects(context.deleteMessageForMeCompat('chat', 'false_other_abc'), /not loaded in this chat/);
  await assert.rejects(context.deleteMessageForMeCompat('unknown', 'false_chat_abc'), /Chat is not loaded/);
  assert.equal(sent.length, 1);
});
