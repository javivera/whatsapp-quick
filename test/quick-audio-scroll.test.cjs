const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Exercise the actual UI playback functions without booting the Tauri window.
const source = fs.readFileSync(path.join(__dirname, '../ui/quick.js'), 'utf8');
const start = source.indexOf('function formatAudioTime(');
const end = source.indexOf('async function openMediaExternally(', start);
assert.ok(start > 0 && end > start);

function setup() {
  const classes = new Set();
  const node = {
    dataset: { messageId: 'latest' },
    classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } },
  };
  const button = { textContent: '', setAttribute() {} };
  const speed = { textContent: '', setAttribute() {} };
  const progress = {
    value: '0', max: '100', disabled: true,
    style: { setProperty(name, value) { this[name] = value; } },
    setAttribute() {},
  };
  const elapsed = { textContent: '' };
  const remaining = { textContent: '' };
  const player = {
    closest() { return node; },
    querySelector(selector) {
      return { '.audio-toggle': button, '.audio-progress': progress, '.audio-speed': speed,
        '.audio-elapsed': elapsed, '.audio-remaining': remaining }[selector];
    },
  };
  const messages = { scrollTop: 475 };
  const state = { playingAudio: null, playingId: null, activeChatId: 'chat',
    audioRequestId: 0, audioCleanup: null, audioPlaybackRate: 1,
    messages: [{ id: 'latest', duration_seconds: 120 }] };
  const audios = [];
  class Audio {
    constructor() { this.paused = true; this.duration = 120; this.currentTime = 0; audios.push(this); }
    async play() { this.paused = false; this.onplay?.(); }
    pause() { this.paused = true; this.onpause?.(); }
  }
  const context = {
    state, Audio, Blob, atob,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    el: { messages, messagesInner: { querySelectorAll: () => [player] } },
    invoke: async () => ({ data: 'AA==', mimetype: 'audio/ogg' }),
    renderMessages: () => { throw new Error('playback must not rebuild messages'); },
  };
  vm.createContext(context);
  vm.runInContext(source.match(/^const AUDIO_RATES = .*;$/m)[0] + '\n' + source.slice(start, end), context);
  return { context, state, button, speed, progress, elapsed, remaining, classes, messages, audios };
}

test('playing, pausing, resuming and ending the newest voice note preserve scroll', async () => {
  const { context, state, button, progress, elapsed, remaining, classes, messages, audios } = setup();
  const msg = { id: 'latest' };
  await context.playAudio(msg);
  assert.equal(button.textContent, '❚❚');
  assert.equal(progress.disabled, false);
  assert.equal(elapsed.textContent, '0:00');
  assert.equal(remaining.textContent, '−2:00');
  assert.ok(classes.has('playing'));
  assert.equal(messages.scrollTop, 475);

  audios[0].currentTime = 45;
  audios[0].ontimeupdate();
  assert.equal(progress.value, '45');
  assert.equal(progress.style['--audio-progress'], '37.5%');
  assert.equal(elapsed.textContent, '0:45');
  assert.equal(remaining.textContent, '−1:15');

  await context.playAudio(msg);
  assert.equal(button.textContent, '▶');
  assert.equal(progress.value, '45');
  assert.equal(messages.scrollTop, 475);

  await context.playAudio(msg);
  assert.equal(button.textContent, '❚❚');
  assert.equal(messages.scrollTop, 475);

  audios[0].onended();
  assert.equal(state.playingId, null);
  assert.equal(button.textContent, '▶');
  assert.equal(progress.disabled, true);
  assert.equal(messages.scrollTop, 475);
});

test('speed steps clamp at 1× and 2×, update the active audio, and carry to the next note', async () => {
  const { context, state, speed, messages, audios } = setup();
  const msg = { id: 'latest' };
  context.changeAudioPlaybackRate(-1);
  assert.equal(speed.textContent, '1×');
  context.changeAudioPlaybackRate(1);
  assert.equal(speed.textContent, '1.5×');
  await context.playAudio(msg);
  assert.equal(audios[0].playbackRate, 1.5);
  context.changeAudioPlaybackRate(1);
  context.changeAudioPlaybackRate(1);
  assert.equal(state.audioPlaybackRate, 2);
  assert.equal(audios[0].playbackRate, 2);
  assert.equal(speed.textContent, '2×');
  assert.equal(messages.scrollTop, 475);
  audios[0].onended();
  await context.playAudio(msg);
  assert.equal(audios[1].playbackRate, 2);
});

test('left/right change speed only for a selected voice message; range arrows still seek', () => {
  const { context, state } = setup();
  state.pane = 'messages';
  state.selectedMsgId = 'latest';
  state.messages[0].type = 'ptt';
  state.recording = false;
  state.menuOpen = false;
  context.el.search = {};
  let onKeydown;
  const document = { activeElement: {}, addEventListener(name, listener) { onKeydown = listener; } };
  const keyboardStart = source.indexOf('document.addEventListener("keydown",');
  const keyboardEnd = source.indexOf('\n});\n\nel.search.addEventListener', keyboardStart);
  assert.ok(keyboardStart > 0 && keyboardEnd > keyboardStart);
  Object.assign(context, {
    document,
    isAudioType: (msg) => msg.type === 'ptt',
    setPane: (pane) => { state.pane = pane; },
  });
  vm.runInContext(source.slice(keyboardStart, keyboardEnd + 4), context);
  const press = (key, target = '') => {
    let prevented = false;
    onKeydown({ key, metaKey: false, ctrlKey: false, altKey: false,
      target: { matches: (selector) => selector.split(', ').includes(target) },
      preventDefault() { prevented = true; } });
    return prevented;
  };
  assert.equal(press('ArrowRight'), true);
  assert.equal(state.audioPlaybackRate, 1.5);
  assert.equal(press('ArrowLeft'), true);
  assert.equal(state.audioPlaybackRate, 1);
  assert.equal(state.pane, 'messages');
  assert.equal(press('ArrowRight', '.audio-progress'), false);
  assert.equal(state.audioPlaybackRate, 1);
  state.messages[0].type = 'chat';
  assert.equal(press('ArrowRight'), true);
  assert.equal(state.pane, 'input');
});
