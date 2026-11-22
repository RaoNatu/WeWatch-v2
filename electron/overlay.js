const stack = document.getElementById('stack');
const timers = new Map();
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
    if (!stack.children.length) window.overlayApi.hide();
  }, 340);
}

function makeNotice(payload, id) {
  const actions = {
    play: { verb: 'played', icon: '▶', prep: 'AT' },
    pause: { verb: 'paused', icon: 'Ⅱ', prep: 'AT' },
    seek: { verb: 'sought', icon: '↔', prep: 'TO' },
    join: { verb: 'joined', icon: '+', prep: 'AT' },
    leave: { verb: 'left', icon: '↗', prep: 'AT' },
  };
  const action = actions[payload.action] ? payload.action : 'pause';
  const details = actions[action];
  const notice = document.createElement('section');
  notice.className = 'notice enter';
  notice.dataset.id = id;
  notice.setAttribute('aria-label', `${payload.name || 'A viewer'} ${details.verb}`);

  const icon = document.createElement('div');
  icon.className = 'notice-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = details.icon;

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
  time.textContent = formatTime(payload.position);
  timeLine.append(preposition, time);
  copy.append(heading, timeLine);

  const mark = document.createElement('span');
  mark.className = 'brand-mark';
  mark.textContent = 'WW';
  notice.append(icon, copy, mark);
  return notice;
}

function showNotice(payload) {
  const id = ++sequence;
  const notice = makeNotice(payload, id);
  stack.prepend(notice);
  while (stack.children.length > maximumNotices) {
    const oldest = stack.lastElementChild;
    clearTimeout(timers.get(Number(oldest.dataset.id)));
    timers.delete(Number(oldest.dataset.id));
    oldest.remove();
  }
  updateWindowSize();
  const duration = Math.min(6000, Math.max(1000, Number(payload.duration) || 2000));
  timers.set(id, setTimeout(() => removeNotice(id, notice), duration));
}

window.overlayApi.onShow(showNotice);
