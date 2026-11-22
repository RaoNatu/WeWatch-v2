const stack = document.getElementById('stack');
const timers = new Map();
const pendingNotices = [];
let sequence = 0;
const maximumNotices = 4;
const cardHeight = 82;
const gap = 8;

function formatTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, '0')).join(':');
}

function updateWindowSize() {
  const count = stack.children.length;
  window.overlayApi.resize(count ? count * cardHeight + (count - 1) * gap : cardHeight);
}

function removeNotice(id, notice) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  notice.classList.remove('enter');
  notice.classList.add('leave');
  setTimeout(() => {
    notice.remove();
    updateWindowSize();
    if (pendingNotices.length) showNotice(pendingNotices.shift());
    else if (!stack.children.length) window.overlayApi.hide();
  }, 340);
}

function makeNotice(payload, id) {
  const actions = {
    play: { verb: 'played', icon: '▶', prep: 'AT' },
    pause: { verb: 'paused', icon: 'Ⅱ', prep: 'AT' },
    seek: { verb: 'sought', icon: '↔', prep: 'TO' },
    join: { verb: 'joined', icon: '+', prep: 'AT' },
    leave: { verb: 'left', icon: '↗', prep: 'AT' },
    movie: { verb: 'selected', icon: '▣', prep: 'FILE' },
    chat: { verb: 'said', icon: '…', prep: 'MESSAGE' },
    reaction: { verb: 'reacted', icon: '♥', prep: 'WITH' },
  };
  const action = actions[payload.action] ? payload.action : 'pause';
  const details = actions[action];
  const notice = document.createElement('section');
  notice.className = 'notice enter';
  notice.dataset.id = id;
  const content = action === 'chat' ? payload.text : action === 'reaction' ? payload.reaction : '';
  notice.setAttribute('aria-label', `${payload.name || 'A viewer'} ${details.verb}${content ? `: ${content}` : ''}`);

  const icon = document.createElement('div');
  icon.className = 'notice-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = action === 'reaction' ? String(payload.reaction || details.icon) : details.icon;

  const copy = document.createElement('div');
  copy.className = 'notice-copy';
  const heading = document.createElement('div');
  heading.className = 'notice-heading';
  const name = document.createElement('strong');
  name.textContent = String(payload.name || 'A viewer').slice(0, 32);
  const verb = document.createElement('span');
  verb.textContent = details.verb;
  heading.append(name, verb);
  const timeLine = document.createElement('div');
  timeLine.className = 'notice-time';
  const preposition = document.createElement('span');
  preposition.textContent = details.prep;
  const time = document.createElement('time');
  time.textContent = action === 'movie' ? String(payload.fileName || 'Movie selected') : action === 'chat' ? String(payload.text || '') : action === 'reaction' ? String(payload.reaction || '') : formatTime(payload.position);
  if (action === 'movie') timeLine.classList.add('file-name');
  if (action === 'chat' || action === 'reaction') timeLine.classList.add('message-content');
  timeLine.append(preposition, time);
  copy.append(heading, timeLine);

  const mark = document.createElement('img');
  mark.className = 'brand-mark';
  mark.src = '../public/we-watch.png';
  mark.alt = '';
  notice.append(icon, copy, mark);
  return notice;
}

function showNotice(payload) {
  if (stack.children.length >= maximumNotices) {
    pendingNotices.push(payload);
    return;
  }
  const id = ++sequence;
  const notice = makeNotice(payload, id);
  stack.prepend(notice);
  updateWindowSize();
  const duration = Math.min(6000, Math.max(1000, Number(payload.duration) || 2000));
  timers.set(id, setTimeout(() => removeNotice(id, notice), duration));
}

window.overlayApi.onShow(showNotice);
