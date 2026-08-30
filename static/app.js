'use strict';

/* BP Counter — клиент */

var STORE_KEY = 'bp_code';
var CAT_KEY = 'bp_cat';
var ALL = '__all__';
var ROUTINE = '__routine__';
var state = null;
var code = null;
var toastTimer = null;
var activeCat = localStorage.getItem(CAT_KEY) || ALL;
var editMode = false;
var openSteps = {};   // какие счётчики сейчас развёрнуты

var $ = function (id) { return document.getElementById(id); };

/* --------------------------------------------------------------- сеть */

function api(path, body) {
  var opts = { method: 'GET', headers: {} };
  if (body) {
    opts.method = 'POST';
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  return fetch(path, opts).then(function (r) {
    return r.json().then(function (data) {
      if (!r.ok) throw new Error(data.error || 'Ошибка сервера');
      return data;
    });
  });
}

function push(path, body) {
  body = body || {};
  body.code = code;
  return api(path, body).then(apply).catch(function (e) {
    toast(e.message);
    return refresh();
  });
}

function refresh() {
  if (!code) return Promise.resolve();
  return api('/api/state?code=' + encodeURIComponent(code))
    .then(apply)
    .catch(function () { /* сеть недоступна — оставляем как есть */ });
}

/* --------------------------------------------------------------- утилиты */

function toast(text) {
  var el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.hidden = true; }, 2200);
}

function pretty(c) {
  return (c || '').replace(/(.{4})(?=.)/g, '$1-');
}

function copy(text) {
  var done = function () { toast('Код скопирован'); };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { toast('Скопируйте вручную'); }
  document.body.removeChild(ta);
}

function untilReset(iso) {
  var diff = new Date(iso) - new Date();
  if (diff < 0) diff = 0;
  var h = Math.floor(diff / 3600000);
  var m = Math.floor(diff / 60000) % 60;
  return h + 'ч ' + (m < 10 ? '0' : '') + m + 'м';
}

/* 1 шаг, 2 шага, 5 шагов */
function plural(n, one, few, many) {
  var mod100 = n % 100;
  var mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function dayLabel(key) {
  var p = key.split('-');
  return p.length === 3 ? p[2] + '.' + p[1] : key;
}

/* --------------------------------------------------------------- отрисовка */

function apply(next) {
  state = next;
  render();
}

function render() {
  if (!state) return;
  var hidden = state.hidden || [];
  var all = state.tasks;
  // в обычном режиме недоступные задания не показываем вовсе
  var tasks = editMode ? all : all.filter(function (t) { return hidden.indexOf(t.id) === -1; });
  var done = state.done;
  var progress = state.progress || {};
  var mult = state.multiplier;

  /* шапка + герой */
  var badge = $('mult-badge');
  badge.textContent = 'x' + mult;
  badge.hidden = mult === 1;

  $('today-bp').textContent = state.today;
  $('total-bp').textContent = state.total;
  $('reset-in').textContent = untilReset(state.next_reset);
  var avail = all.filter(function (t) { return hidden.indexOf(t.id) === -1; });
  $('done-count').textContent = done.length;
  $('task-count').textContent = avail.length;
  $('max-bp').textContent = state.max_today;
  $('hero-bar').style.width =
    (state.max_today ? state.today / state.max_today * 100 : 0) + '%';

  /* задания по группам */
  var list = $('task-list');
  // собираем список во фрагменте и подменяем одним махом:
  // если очистить список заранее, страница на миг схлопывается и браузер уводит прокрутку наверх
  var frag = document.createDocumentFragment();
  var groups = [];
  var byGroup = {};
  tasks.forEach(function (t) {
    var g = t.group || 'Задания';
    if (!byGroup[g]) { byGroup[g] = []; groups.push(g); }
    byGroup[g].push(t);
  });

  // маршрут: только существующие и доступные задания, в заданном порядке
  var byId = {};
  all.forEach(function (t) { byId[t.id] = t; });
  // шаги маршрута: {id, part} — задание со счётчиком может идти несколькими шагами
  var routine = (state.routine || []).filter(function (r) {
    return byId[r.id] && hidden.indexOf(r.id) === -1;
  });

  if (activeCat === ROUTINE && !routine.length) activeCat = ALL;
  if (activeCat !== ALL && activeCat !== ROUTINE && groups.indexOf(activeCat) === -1) activeCat = ALL;
  renderCats(groups, byGroup, done, routine, byId);

  if (!tasks.length) {
    frag.appendChild(el('div', 'empty', 'Заданий нет. Добавьте свои в настройках.'));
  }

  if (activeCat === ROUTINE) {
    // шаг считается пройденным, когда счётчик дошёл до конца этой порции
    var upto = {};
    var stepDone = routine.map(function (r) {
      var t = byId[r.id];
      if (!t.steps) return done.indexOf(r.id) !== -1;
      upto[r.id] = (upto[r.id] || 0) + r.part;
      return (progress[r.id] || 0) >= upto[r.id];
    });
    var nextIndex = stepDone.indexOf(false);

    var rwrap = el('div', 'group');
    var rinner = el('div', 'group__list');
    var cum = {};
    routine.forEach(function (r, i) {
      var t = byId[r.id];
      var row = taskRow(t, done, hidden, mult, progress);
      row.classList.toggle('is-done', stepDone[i]);
      if (i === nextIndex) row.classList.add('is-next');
      row.insertBefore(el('span', 'task__step', String(i + 1)), row.firstChild);

      // кнопка «сделал порцию целиком»
      if (t.steps) {
        cum[r.id] = (cum[r.id] || 0) + r.part;
        var target = cum[r.id];
        var chunk = el('button', 'task__chunk', '+' + r.part);
        chunk.type = 'button';
        chunk.disabled = (progress[r.id] || 0) >= target;
        chunk.title = 'Засчитать ' + r.part + ' — станет ' + target + ' из ' + t.steps;
        chunk.addEventListener('click', function (e) {
          e.stopPropagation();
          push('/api/progress', { id: r.id, delta: r.part });
        });
        var anchor = row.querySelector('.task__bp');
        row.insertBefore(chunk, anchor);
      }

      rinner.appendChild(row);
    });
    rwrap.appendChild(rinner);
    frag.appendChild(rwrap);
  } else {
    var shown = activeCat === ALL ? groups : [activeCat];
    shown.forEach(function (g) {
      var wrap = el('div', 'group');
      if (activeCat === ALL) wrap.appendChild(el('h2', 'group__title', g));
      var inner = el('div', 'group__list');
      byGroup[g].forEach(function (t) {
        inner.appendChild(taskRow(t, done, hidden, mult, progress));
      });
      wrap.appendChild(inner);
      frag.appendChild(wrap);
    });
  }

  if (list.replaceChildren) {
    list.replaceChildren(frag);
  } else {                       // запасной путь для старых браузеров
    var y = window.pageYOffset;
    list.innerHTML = '';
    list.appendChild(frag);
    window.scrollTo(0, y);
  }

  /* статистика */
  $('s-today').textContent = state.today + ' / ' + state.max_today;
  $('s-total').textContent = state.total;
  $('s-mult').textContent = 'x' + mult;

  var hist = state.history || {};
  var days = Object.keys(hist).sort().reverse();
  var sum = days.reduce(function (a, d) { return a + hist[d]; }, 0);
  $('s-avg').textContent = days.length ? Math.round(sum / days.length) : state.today;

  var box = $('history');
  box.textContent = '';
  if (!days.length) {
    box.appendChild(el('div', 'empty', 'Пока нет завершённых дней. Первый появится после сброса в 07:00 МСК.'));
  } else {
    var max = Math.max.apply(null, days.map(function (d) { return hist[d]; }));
    days.slice(0, 30).forEach(function (d) {
      var row = el('div', 'hrow');
      row.appendChild(el('span', 'hrow__date', dayLabel(d)));
      var bar = el('span', 'hrow__bar');
      var fill = el('i');
      fill.style.width = (max ? hist[d] / max * 100 : 0) + '%';
      bar.appendChild(fill);
      row.appendChild(bar);
      row.appendChild(el('span', 'hrow__bp', hist[d] + ' BP'));
      box.appendChild(row);
    });
  }

  /* маршрут */
  renderRoutine(all, byId, routine, hidden, done, mult);

  /* настройки */
  $('opt-vip').checked = state.vip;
  $('opt-x2week').checked = state.x2week;
  $('set-mult').textContent = 'x' + mult;
  $('my-code').textContent = pretty(state.code);

  var clist = $('custom-list');
  clist.textContent = '';
  var custom = tasks.filter(function (t) { return t.custom; });
  if (!custom.length) {
    clist.appendChild(el('div', 'empty', 'Своих заданий нет. Добавьте те, которых нет в списке.'));
  }
  custom.forEach(function (t) {
    var row = el('div', 'crow');
    row.appendChild(el('span', 'crow__name', t.name));
    row.appendChild(el('span', 'crow__bp', t.bp + ' BP'));
    var del = el('button', 'crow__del', 'Удалить');
    del.type = 'button';
    del.addEventListener('click', function () { push('/api/custom/remove', { id: t.id }); });
    row.appendChild(del);
    clist.appendChild(row);
  });
}

/* вкладка «Маршрут»: порядок прохождения дня */
function renderRoutine(all, byId, routine, hidden, done, mult) {
  var saveOrder = function (order) { push('/api/routine', { order: order }); };

  /* сводка: BP считаем по заданиям, а не по шагам */
  var uniq = {};
  var base = 0;
  var parts = {};
  routine.forEach(function (r) {
    if (!uniq[r.id]) { uniq[r.id] = true; base += byId[r.id].bp; }
    if (byId[r.id].steps) parts[r.id] = (parts[r.id] || 0) + r.part;
  });

  // задания, у которых порции не складываются в полный счётчик
  var gaps = Object.keys(parts).filter(function (id) {
    return parts[id] !== byId[id].steps;
  });

  var sum = $('routine-sum');
  sum.textContent = '';
  if (routine.length) {
    var doneCount = routine.filter(function (r) { return done.indexOf(r.id) !== -1; }).length;
    sum.appendChild(el('span', 'routine-sum__main', routine.length + ' ' +
      plural(routine.length, 'шаг', 'шага', 'шагов') + ' · ' + base * mult + ' BP'));
    sum.appendChild(el('span', 'routine-sum__sub',
      'заданий пройдено ' + doneCount + ' · потолок дня ' + state.max_today + ' BP'));
    gaps.forEach(function (id) {
      sum.appendChild(el('span', 'routine-sum__warn',
        byId[id].name + ': расписано ' + parts[id] + ' из ' + byId[id].steps));
    });
  }

  /* сам маршрут */
  var list = $('routine-list');
  var frag = document.createDocumentFragment();

  if (!routine.length) {
    frag.appendChild(el('div', 'empty',
      'Маршрут пока пуст. Добавьте задания снизу — в том порядке, в каком их делаете.'));
  }

  routine.forEach(function (r, i) {
    var t = byId[r.id];
    var isDone = done.indexOf(r.id) !== -1;
    var row = el('div', 'rrow' + (isDone ? ' is-done' : ''));

    row.appendChild(el('span', 'rrow__num', String(i + 1)));
    row.appendChild(el('span', 'rrow__name', t.name));
    row.appendChild(el('span', 'rrow__bp', '+' + t.bp * mult));

    var ctrl = el('span', 'rrow__ctrl');

    var up = el('button', 'rrow__btn', '↑');
    up.type = 'button';
    up.disabled = i === 0;
    up.setAttribute('aria-label', 'Выше');
    up.addEventListener('click', function () {
      var order = routine.slice();
      order.splice(i - 1, 0, order.splice(i, 1)[0]);
      saveOrder(order);
    });

    var down = el('button', 'rrow__btn', '↓');
    down.type = 'button';
    down.disabled = i === routine.length - 1;
    down.setAttribute('aria-label', 'Ниже');
    down.addEventListener('click', function () {
      var order = routine.slice();
      order.splice(i + 1, 0, order.splice(i, 1)[0]);
      saveOrder(order);
    });

    var del = el('button', 'rrow__btn rrow__btn--del', '✕');
    del.type = 'button';
    del.setAttribute('aria-label', 'Убрать шаг');
    del.addEventListener('click', function () {
      var order = routine.slice();
      order.splice(i, 1);              // убираем именно этот шаг, а не все с этим заданием
      saveOrder(order);
    });

    ctrl.appendChild(up);
    ctrl.appendChild(down);
    ctrl.appendChild(del);
    row.appendChild(ctrl);

    /* сколько действий делаем за этот заход */
    if (t.steps) {
      var partBox = el('div', 'rrow__part');
      partBox.appendChild(el('span', 'rrow__part-label', 'за раз'));

      var input = document.createElement('input');
      input.className = 'rrow__part-input';
      input.type = 'number';
      input.inputMode = 'numeric';
      input.min = 1;
      input.max = t.steps;
      input.value = r.part;
      input.setAttribute('aria-label', 'Сколько действий за этот заход');
      input.addEventListener('change', function () {
        var v = parseInt(input.value, 10);
        if (!v || v < 1) v = 1;
        if (v > t.steps) v = t.steps;
        var order = routine.map(function (x, j) {
          return j === i ? { id: x.id, part: v } : x;
        });
        saveOrder(order);
      });
      partBox.appendChild(input);
      partBox.appendChild(el('span', 'rrow__part-label', 'из ' + t.steps));

      var split = el('button', 'rrow__split', '+ ещё заход');
      split.type = 'button';
      split.title = 'Разбить задание на ещё один шаг';
      split.addEventListener('click', function () {
        var left = Math.max(1, t.steps - (parts[r.id] || 0));
        var order = routine.slice();
        order.splice(i + 1, 0, { id: r.id, part: left });
        saveOrder(order);
      });
      partBox.appendChild(split);

      row.appendChild(partBox);
    }

    frag.appendChild(row);
  });

  if (list.replaceChildren) list.replaceChildren(frag);
  else { list.innerHTML = ''; list.appendChild(frag); }

  /* что можно добавить */
  var addBox = $('routine-add');
  var addFrag = document.createDocumentFragment();
  var inRoutine = {};
  routine.forEach(function (r) { inRoutine[r.id] = true; });
  var rest = all.filter(function (t) {
    return hidden.indexOf(t.id) === -1 && !inRoutine[t.id];
  });

  if (!rest.length) {
    addFrag.appendChild(el('div', 'empty',
      'Все доступные задания уже в маршруте. Разбить на несколько заходов можно кнопкой «+ ещё заход».'));
  } else {
    var groups = [];
    var byGroup = {};
    rest.forEach(function (t) {
      var g = t.group || 'Задания';
      if (!byGroup[g]) { byGroup[g] = []; groups.push(g); }
      byGroup[g].push(t);
    });
    groups.forEach(function (g) {
      addFrag.appendChild(el('h3', 'group__title', g));
      var box = el('div', 'addbox');
      byGroup[g].forEach(function (t) {
        var b = el('button', 'addchip');
        b.type = 'button';
        b.appendChild(el('span', null, t.name));
        b.appendChild(el('span', 'addchip__bp', '+' + t.bp * mult));
        b.addEventListener('click', function () {
          saveOrder(routine.concat([{ id: t.id, part: t.steps || null }]));
        });
        box.appendChild(b);
      });
      addFrag.appendChild(box);
    });
  }

  if (addBox.replaceChildren) addBox.replaceChildren(addFrag);
  else { addBox.innerHTML = ''; addBox.appendChild(addFrag); }
}

/* одна строка задания: простая галочка или галочка со счётчиком */
function taskRow(t, done, hidden, mult, progress) {
  var isDone = done.indexOf(t.id) !== -1;
  var isOff = hidden.indexOf(t.id) !== -1;
  var steps = t.steps || 0;
  var value = Math.min(steps, progress[t.id] || 0);
  var counted = steps && !editMode;

  var isOpen = counted && openSteps[t.id];
  var cls = 'task' + (isDone && !isOff ? ' is-done' : '') + (isOff ? ' is-off' : '') +
            (counted ? ' task--steps' : '') + (isOpen ? ' is-open' : '');
  var row = el(counted ? 'div' : 'button', cls);
  if (!counted) {
    row.type = 'button';
    row.setAttribute('aria-pressed', (editMode ? isOff : isDone) ? 'true' : 'false');
  }

  var checkHtml = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4 4L19 7"/></svg>';
  var check;
  if (counted) {
    // отдельная кнопка: закрыть задание целиком, не считая по одному
    check = el('button', 'task__check');
    check.type = 'button';
    check.title = isDone ? 'Снять отметку' : 'Закрыть задание целиком';
    check.setAttribute('aria-label', check.title);
    check.addEventListener('click', function (e) {
      e.stopPropagation();   // галочка закрывает задание, а не разворачивает строку
      push('/api/task', { id: t.id, done: !isDone });
    });
  } else {
    check = el('span', 'task__check');
  }
  check.innerHTML = checkHtml;
  row.appendChild(check);
  row.appendChild(el('span', 'task__name', t.name));

  if (editMode) {
    row.appendChild(el('span', 'task__flag', isOff ? 'недоступно' : 'скрыть'));
  } else {
    if (counted) {
      // компактный счётчик виден всегда, стeппер разворачивается по тапу
      row.appendChild(el('span', 'task__tally' + (value ? ' is-started' : ''), value + '/' + steps));
    }
    var bp = el('span', 'task__bp');
    bp.textContent = '+' + t.bp * mult + ' BP';
    if (mult > 1) bp.appendChild(el('small', null, ' (' + t.bp + ' x' + mult + ')'));
    row.appendChild(bp);
  }

  if (counted && isOpen) {
    var box = el('div', 'stepper');

    var minus = el('button', 'stepper__btn', '−');
    minus.type = 'button';
    minus.disabled = value === 0;
    minus.setAttribute('aria-label', 'Убрать одно');
    minus.addEventListener('click', function () { push('/api/progress', { id: t.id, delta: -1 }); });

    var val = el('span', 'stepper__val', value + '/' + steps);

    var plus = el('button', 'stepper__btn stepper__btn--plus', '+');
    plus.type = 'button';
    plus.disabled = value >= steps;
    plus.setAttribute('aria-label', 'Добавить одно');
    plus.addEventListener('click', function () { push('/api/progress', { id: t.id, delta: 1 }); });

    box.appendChild(minus);
    box.appendChild(val);
    box.appendChild(plus);

    var bar = el('span', 'stepper__bar');
    var fill = el('i');
    fill.style.width = (steps ? value / steps * 100 : 0) + '%';
    bar.appendChild(fill);
    box.appendChild(bar);

    // клик внутри стeппера не должен схлопывать строку
    box.addEventListener('click', function (e) { e.stopPropagation(); });
    row.appendChild(box);
  }

  if (counted) {
    row.addEventListener('click', function () {
      openSteps[t.id] = !openSteps[t.id];
      render();
    });
  } else {
    row.addEventListener('click', function () {
      if (editMode) {
        push('/api/hidden', { id: t.id, hidden: !isOff });
        return;
      }
      var nowDone = row.classList.toggle('is-done');   // мгновенный отклик
      row.setAttribute('aria-pressed', nowDone ? 'true' : 'false');
      push('/api/task', { id: t.id, done: nowDone });
    });
  }

  return row;
}

/* горизонтальная лента категорий */
function renderCats(groups, byGroup, done, routine, byId) {
  var bar = $('cat-bar');
  var scroll = bar.scrollLeft;   // не сбрасывать прокрутку при перерисовке
  bar.textContent = '';

  var items = [];
  if (routine && routine.length) items.push({ key: ROUTINE, name: 'Маршрут' });
  items.push({ key: ALL, name: 'Все' });
  groups.forEach(function (g) { items.push({ key: g, name: g }); });

  items.forEach(function (item) {
    var pool;
    if (item.key === ROUTINE) {
      var uniq = {};                       // задание может идти несколькими шагами
      pool = [];
      routine.forEach(function (r) {
        if (!uniq[r.id]) { uniq[r.id] = 1; pool.push(byId[r.id]); }
      });
    } else if (item.key === ALL) {
      pool = groups.reduce(function (a, g) { return a.concat(byGroup[g]); }, []);
    } else {
      pool = byGroup[item.key];
    }
    var doneCount = pool.filter(function (t) { return done.indexOf(t.id) !== -1; }).length;
    var isDone = doneCount === pool.length && pool.length > 0;
    var on = item.key === activeCat;

    var chip = el('button', 'chip' + (on ? ' is-active' : '') + (isDone ? ' is-full' : '') +
                             (item.key === ROUTINE ? ' chip--routine' : ''));
    chip.type = 'button';
    chip.setAttribute('role', 'tab');
    chip.setAttribute('aria-selected', on ? 'true' : 'false');
    chip.appendChild(el('span', 'chip__name', item.name));
    chip.appendChild(el('span', 'chip__count', doneCount + '/' + pool.length));

    chip.addEventListener('click', function () {
      activeCat = item.key;
      localStorage.setItem(CAT_KEY, activeCat);
      render();
      var active = bar.querySelector('.chip.is-active');
      if (active) active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    });

    bar.appendChild(chip);
  });

  bar.scrollLeft = scroll;
}

function el(tag, cls, text) {
  var node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

/* --------------------------------------------------------------- экраны */

function show(screen) {
  $('auth').hidden = screen !== 'auth';
  $('welcome').hidden = screen !== 'welcome';
  $('app').hidden = screen !== 'app';
}

function enter(data) {
  code = data.code;
  localStorage.setItem(STORE_KEY, code);
  apply(data);
  show('app');
}

/* --------------------------------------------------------------- события */

$('code-input').addEventListener('input', function (e) {
  var raw = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  e.target.value = pretty(raw);
});

$('login-form').addEventListener('submit', function (e) {
  e.preventDefault();
  var err = $('auth-error');
  var raw = $('code-input').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw.length !== 16) {
    err.textContent = 'Код должен быть из 16 символов';
    err.hidden = false;
    return;
  }
  err.hidden = true;
  api('/api/login', { code: raw }).then(enter).catch(function (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  });
});

$('register-btn').addEventListener('click', function () {
  api('/api/register', {}).then(function (data) {
    state = data;
    code = data.code;
    $('new-code').textContent = pretty(data.code);
    show('welcome');
  }).catch(function (ex) { toast(ex.message); });
});

$('copy-code').addEventListener('click', function () { copy(state.code); });
$('copy-my-code').addEventListener('click', function () { copy(state.code); });

$('welcome-continue').addEventListener('click', function () { enter(state); });

$('logout').addEventListener('click', function () {
  localStorage.removeItem(STORE_KEY);
  code = null;
  state = null;
  $('code-input').value = '';
  $('auth-error').hidden = true;
  show('auth');
});

Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (tab) {
  tab.addEventListener('click', function () {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      var on = t === tab;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    Array.prototype.forEach.call(document.querySelectorAll('.panel'), function (p) {
      p.classList.toggle('is-active', p.id === 'panel-' + tab.dataset.tab);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
});

$('opt-vip').addEventListener('change', function (e) {
  push('/api/settings', { vip: e.target.checked });
});
$('opt-x2week').addEventListener('change', function (e) {
  push('/api/settings', { x2week: e.target.checked });
});

$('custom-form').addEventListener('submit', function (e) {
  e.preventDefault();
  var name = $('custom-name').value.trim();
  var bp = parseInt($('custom-bp').value, 10);
  if (!name || !bp || bp < 1) { toast('Введите название и количество BP'); return; }
  api('/api/custom/add', { code: code, name: name, bp: bp }).then(function (data) {
    $('custom-name').value = '';
    $('custom-bp').value = '';
    apply(data);
  }).catch(function (ex) { toast(ex.message); });
});

$('uncheck-all').addEventListener('click', function () {
  push('/api/reset');
});

$('edit-mode').addEventListener('click', function () {
  editMode = !editMode;
  this.textContent = editMode ? 'Готово' : 'Настроить доступность';
  this.classList.toggle('btn--primary', editMode);
  this.classList.toggle('btn--ghost', !editMode);
  $('edit-hint').hidden = !editMode;
  $('uncheck-all').hidden = editMode;
  render();
});

/* --------------------------------------------------------------- старт */

setInterval(function () {
  if (state) $('reset-in').textContent = untilReset(state.next_reset);
}, 30000);

// раз в минуту сверяемся с сервером — поймаем сброс в 07:00 и правки с других устройств
setInterval(refresh, 60000);
document.addEventListener('visibilitychange', function () {
  if (!document.hidden) refresh();
});

(function start() {
  var saved = localStorage.getItem(STORE_KEY);
  if (!saved) { show('auth'); return; }
  api('/api/login', { code: saved }).then(enter).catch(function () {
    localStorage.removeItem(STORE_KEY);
    show('auth');
  });
})();
