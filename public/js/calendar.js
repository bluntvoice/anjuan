// 日历：月历网格 + 事件 chip + 跨天车道长条 + 假期标注。
// 🔴 性能红线：.cal-cell 单页可达 42 个 —— 任何皮肤都不给它上 backdrop-filter（见 css/style.css A-19）。
// DOM 契约：#dow 只填一次（常驻）；#grid 每次 load() 整体 replaceChildren 重建，重建单位是「周行」。
//   周行 .cal-week 是 7 列嵌套网格；日期格 / 日期数字 / 车道长条 / chip 堆都是它的同级网格项：
//   .cal-cell 占 grid-row 1/-1 当背景与命中面，.cal-daynum 占第 1 行，长条占车道行，.cal-day-chips 占末行。
//   —— 长条因此在整个周行里恒占同一水平车道，不再被格内 chip 数量顶得高低错落。
import { api, el, todayStr, SEV_LABEL, STATUS_LABEL } from './api.js';
import { mountNav } from './nav.js';
import { viewTask } from './calendar-task-modal.js';
import { caseColorStyle } from './calendar-ui.js';
import { bindFold, setFoldOpen } from './fold.js';

// task 三态标签（api.js 的 STATUS_LABEL 是 deadline 专用四态，不混用）
const TASK_STATUS_LABEL = { open: '', done: '已完成', dropped: '已放弃' };

await mountNav();

const title = document.getElementById('cal-title');
const loadMeta = document.getElementById('cal-load');
const grid = document.getElementById('grid');
const trayList = document.getElementById('unplanned-list');
const trayCount = document.getElementById('unplanned-count');
const tray = document.getElementById('cal-tray');

// 星期头：加载时填一次，load() 不重建它
const dow = document.getElementById('dow');
for (const d of ['一', '二', '三', '四', '五', '六', '日']) dow.append(el('div', { class: 'cal-dow' }, d));

let current = todayStr().slice(0, 7); // YYYY-MM
let calendarData = null;
const expanded = new Set(); // 周行序号；翻月时由导航动作清空，普通重绘保留

const PRIORITY_LABEL = { high: '高优先', normal: '一般', low: '低优先' };

function taskPriorityClass(priority) {
  if (priority === 'high') return 'pill crit';
  if (priority === 'normal') return 'pill acc';
  return 'pill';
}

function isNarrow() {
  return window.matchMedia('(max-width: 767px)').matches;
}

bindFold(tray, 'calendar-tray', true);
function syncResponsiveCopy() {
  setFoldOpen(tray, true, { persist: false });
  tray.classList.toggle('is-tray-strip', isNarrow());
}

function shiftDate(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function monthEnd(ym) {
  const [year, month] = ym.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function taskLabel(task) {
  return task.due_time ? `${task.due_time} ${task.title}` : task.title;
}

// 条身 / 单日 chip / 托盘条目拖动 = 整体平移排期：跨度不变，两端同步移。
// 只有「本来就没有区间」的（托盘未排期、或缺 plan_date）才把两端一起钉到落点。
function renderTray(tasks) {
  const unplanned = tasks;
  trayCount.textContent = unplanned.length ? `${unplanned.length} 条` : '';
  if (!unplanned.length) {
    trayList.replaceChildren(el('p', { class: 'cal-tray-empty' }, '所有开放待办都已排到日历上。'));
    return;
  }
  trayList.replaceChildren(...unplanned.map((task) => el('button', {
    class: 'unplanned-item', type: 'button',
    draggable: 'false', style: caseColorStyle(task.case_id),
    'aria-label': '查看待办：' + task.title,
    onclick: () => viewTask(task),
  },
    el('span', { class: 'unplanned-dot', 'aria-hidden': 'true' }),
    el('strong', { class: 'unplanned-title' }, taskLabel(task)),
    el('span', { class: 'unplanned-case' }, task.case_name || '不挂案件'),
    el('span', { class: taskPriorityClass(task.priority) }, PRIORITY_LABEL[task.priority] || '一般')
  )));
}

function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

// severity / status → .cal-chip 修饰类。
// 两者正交：已处理的致命死线保留红边条，只是灰显划线（CSS 的 .done 是叠加态，不是互斥态）。
function chipClass(severity, status) {
  const c = ['cal-chip'];
  if (severity === 'critical') c.push('crit');
  else if (severity === 'high') c.push('warn');
  if (status !== 'pending') c.push('done');
  return c.join(' ');
}

// task chip 的 class —— 与 chipClass 同构：边条永远 .task，done/dropped 叠 .done 灰显。
function taskChipClass(status) {
  const c = ['cal-chip', 'task'];
  if (status !== 'open') c.push('done');
  return c.join(' ');
}

// 一个周行内的一段长条（seg = { task, from, to, c0, c1, lane }）。
// 真端点落在本段里才画 .start/.end 与把手；被周界/月界切断的那头是 .continued-*（方角 = 还没完）。
function taskSpanNode(seg, monthStart, monthLast) {
  const task = seg.task;
  const startVisible = task.plan_date === seg.from && task.plan_date >= monthStart;
  const endVisible = task.due_on === seg.to && task.due_on <= monthLast;
  const cls = ['cal-span', 'task-span'];
  cls.push(startVisible ? 'start' : 'continued-start');
  cls.push(endVisible ? 'end' : 'continued-end');
  if (task.status !== 'open') cls.push('done');
  const children = [el('span', { class: 'cal-span-label' }, taskLabel(task))];
  return el('div', {
    class: cls.join(' '), role: 'button', tabindex: '0', draggable: 'false',
    style: `${caseColorStyle(task.case_id)};grid-column:${seg.c0 + 1}/${seg.c1 + 2};grid-row:${seg.lane + 2}`,
    title: `跨天待办 · ${taskLabel(task)} · ${task.plan_date} 至 ${task.due_on}`,
    'aria-label': `跨天待办：${taskLabel(task)}，${task.plan_date}至${task.due_on}`,
    onclick: () => viewTask(task),
    onkeydown: e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); viewTask(task); }
    },
  }, children);
}

// ── 筛选器：图例即开关 ──
// 类型四档（致命 / 重要·一般 / 开庭 / 待办）默认开，「已处理」默认关 ——
// 与 deadlines 现有的「全状态返回、前端灰显」模式对齐：默认只看在追的，
// 想看历史就点亮「已处理」。
const FILTER_KEYS = ['crit', 'warn', 'hearing', 'task', 'done'];
const FILTER_DEFAULT = { crit: true, warn: true, hearing: true, task: true, done: false };
const FILTER_STORE = 'anjian-cal-filter';

// localStorage 在隐私模式 / 禁 Cookie 下会抛 —— 筛选是装饰，绝不炸整页（同 skin.js 惯例）
function readFilters() {
  try {
    const raw = JSON.parse(localStorage.getItem(FILTER_STORE) || '{}');
    return { ...FILTER_DEFAULT, ...pick(raw) };
  } catch { return { ...FILTER_DEFAULT }; }
}
function writeFilters(f) {
  try { localStorage.setItem(FILTER_STORE, JSON.stringify(f)); } catch { /* noop */ }
}
function pick(obj) {
  const o = {};
  for (const k of FILTER_KEYS) if (typeof obj[k] === 'boolean') o[k] = obj[k];
  return o;
}
let filters = readFilters();

// 单条事项是否该画。两类维度正交：先过类型开关，再过「已处理」开关。
// 「已处理」= deadline.status !== 'pending' 或 task.status !== 'open'；开庭无 status，永不被它挡。
function visible(kind, item) {
  if (!filters[kind]) return false;
  const processed =
    (kind === 'crit' || kind === 'warn') ? item.status !== 'pending' :
    (kind === 'task') ? item.status !== 'open' : false;
  return !processed || filters.done;
}

let loadSequence = 0;
async function load({ refresh = true } = {}) {
  if (refresh) {
    const sequence = ++loadSequence;
    const month = current;
    try {
      const data = await api('/case-dashboard/calendar?' + new URLSearchParams({ month }));
      if (sequence !== loadSequence) return;
      calendarData = data;
    } catch {
      if (sequence === loadSequence) {
        title.textContent = month;
        loadMeta.textContent = '月份读取失败';
        grid.replaceChildren();
        renderTray([]);
      }
      return;
    }
  }
  const data = calendarData;
  if (!data || data.month !== current) return;
  const monthTasks = data.tasks;
  const today = todayStr();
  const [y, m] = current.split('-').map(Number);

  // 标题 = 月份本体；当前月挂「本月」标记（翻走即消失，与「今天」键呼应）
  // ⚠ replaceChildren 会把 null 转成字面量 "null" 文本节点（不像 el() 会跳过）——只能传真节点。
  const head = [el('span', { class: 'date' }, `${y} 年 ${String(m).padStart(2, '0')} 月`)];
  if (current === today.slice(0, 7)) head.push(el('span', { class: 'wk' }, '本月'));
  title.replaceChildren(...head);

  // 本月负荷：计数只算当前筛选可见的事项 —— 与格子显示保持一致。
  // 致命计数恒反映真实未处理量（不受 .crit 关闭影响）：它是安全警示，不是展示偏好。
  const vd = data.deadlines.filter((d) => visible(d.severity === 'critical' ? 'crit' : 'warn', d));
  const vh = filters.hearing ? data.hearings : [];
  const vt = monthTasks.filter((t) => visible('task', t));
  const critLeft = data.deadlines.filter((d) => d.status === 'pending' && d.severity === 'critical').length;
  const parts = [];
  if (vd.length) parts.push(el('span', { class: 'm' }, `期限 ${vd.length}`));
  if (vh.length) parts.push(el('span', { class: 'm' }, `开庭 ${vh.length}`));
  if (vt.length) parts.push(el('span', { class: 'm' }, `待办 ${vt.length}`));
  if (critLeft) parts.push(el('span', { class: 'm hot' }, `致命 ${critLeft}`));
  // 「·」做分隔符，插在相邻项之间
  const spaced = [];
  for (const p of parts) { if (spaced.length) spaced.push(el('span', {}, '·')); spaced.push(p); }
  loadMeta.replaceChildren(...(spaced.length ? spaced : [el('span', {}, '本月无排期')]));

  // 按日聚合 chip：期限 → 开庭 → 待办；同日有截止时刻的待办先排，并按 HH:MM 排序。
  // 跨天长条不进这里 —— 它按周行走车道，见下面的 ranges。
  const byDay = new Map();
  let pushSeq = 0;
  const push = (date, node, order = 0, time = '') => {
    if (!date) return;
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date).push({ node, order, time, seq: pushSeq++ });
  };
  for (const d of data.deadlines) {
    if (!visible(d.severity === 'critical' ? 'crit' : 'warn', d)) continue;
    const sev = SEV_LABEL[d.severity] || '';
    const st = d.status === 'pending' ? '' : ` · ${STATUS_LABEL[d.status] || d.status}`;
    // 事项名在前、案件在后 —— 与期限跑道 .rw-main 同一信息层级：格子窄，先保住「要做什么」。
    // 全文走 title 悬浮（格内必然截断）。
    // 期限 / 开庭是法定事实，永不可拖（安全铁律）：不挂 pointerdown，并显式关掉 <a> 的原生拖走。
      push(d.due_on, el('a', {
        class: chipClass(d.severity, d.status),
        href: `/case.html?id=${d.case_id}`,
        draggable: 'false',
      title: `${sev}期限 · ${d.name} · ${d.case_name}${st}${d.rolled_from && d.rolled_from < d.due_on ? `\n原届满 ${d.rolled_from} 逢节假日，已顺延至 ${d.due_on} · 建议节前办` : ''}`,
      }, el('span', { class: 'cal-chip-label' }, `${d.name}·${d.case_name}`)), 0);
  }
  for (const h of data.hearings) {
    if (!filters.hearing) continue;
    const time = h.occurred_time ? `${h.occurred_time} ` : '';
    push(h.occurred_on, el('a', {
      class: 'cal-chip hearing',
      href: `/case.html?id=${h.case_id}`,
      draggable: 'false',
      title: `开庭 · ${h.case_name}${h.location ? ' · ' + h.location : ''}${h.note ? ' · ' + h.note : ''}`,
    }, el('span', { class: 'cal-chip-label' }, `${time}开庭·${h.case_name}`)), 1, h.occurred_time || '');
  }
  for (const t of monthTasks) {
    if (!visible('task', t)) continue;
    const hasRange = t.plan_date && t.due_on && t.plan_date < t.due_on;
    if (hasRange) continue;
    const st = TASK_STATUS_LABEL[t.status] ? ` · ${TASK_STATUS_LABEL[t.status]}` : '';
    const taskOrder = t.due_time ? 2 : 3;
    push(t.due_on, el('a', {
      class: taskChipClass(t.status),
      href: `#task-${t.id}`,
      draggable: 'false',
      style: caseColorStyle(t.case_id),
      title: `待办 · ${taskLabel(t)}${t.case_name ? ' · ' + t.case_name : ''}${st}`,
      onclick: e => { e.preventDefault(); viewTask(t); },
    }, el('span', { class: 'cal-chip-label' }, taskLabel(t))), taskOrder, t.due_time || '');
  }
  for (const entries of byDay.values()) {
    entries.sort((a, b) => a.order - b.order
      || (a.time ? 0 : 1) - (b.time ? 0 : 1)
      || a.time.localeCompare(b.time) || a.seq - b.seq);
  }

  // 跨天长条的本月可见区间；按起点排序，供每周行贪心分车道。
  const monthStart = `${current}-01`;
  const monthLast = monthEnd(current);
  const ranges = monthTasks
    .filter((t) => visible('task', t) && t.plan_date && t.due_on && t.plan_date < t.due_on)
    .map((t) => ({
      task: t,
      from: t.plan_date > monthStart ? t.plan_date : monthStart,
      to: t.due_on < monthLast ? t.due_on : monthLast,
    }))
    .filter((r) => r.from <= r.to)
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.task.id - b.task.id);

  // 月格（周一起始）：整体重建，单位是周行
  const first = new Date(Date.UTC(y, m - 1, 1));
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;
  const slots = [];
  for (let i = lead; i > 0; i--) slots.push(shiftDate(`${current}-01`, -i));
  for (let day = 1; day <= daysInMonth; day++) slots.push(`${current}-${String(day).padStart(2, '0')}`);
  while (slots.length % 7) slots.push(shiftDate(monthLast, slots.length - (lead + daysInMonth) + 1));

  grid.replaceChildren();
  for (let w = 0; w * 7 < slots.length; w++) {
    const week = slots.slice(w * 7, w * 7 + 7);
    const dates = week.filter(Boolean);
    const weekStart = dates[0] || '';
    const weekEnd = dates[dates.length - 1] || '';

    // 本周行的长条段 + 贪心车道分配（ranges 已按 from 排序 → 车道内右端单调递增）
    const segs = [];
    if (weekStart) {
      for (const r of ranges) {
        const from = r.from > weekStart ? r.from : weekStart;
        const to = r.to < weekEnd ? r.to : weekEnd;
        if (from > to) continue;
        segs.push({ task: r.task, from, to, c0: week.indexOf(from), c1: week.indexOf(to), lane: 0 });
      }
    }
    const laneEnd = [];
    for (const seg of segs) {
      let lane = laneEnd.findIndex((end) => end < seg.c0);
      if (lane < 0) { lane = laneEnd.length; laneEnd.push(-1); }
      laneEnd[lane] = seg.c1;
      seg.lane = lane;
    }
    const total = laneEnd.length;
    const cap = window.matchMedia('(max-width: 767px)').matches ? 4 : 3;
    const open = expanded.has(w);
    const overflow = !open && total > cap;
    const visLanes = overflow ? cap - 1 : total;
    const hidden = Array(7).fill(0);
    if (overflow) {
      for (const seg of segs) {
        if (seg.lane < visLanes) continue;
        for (let i = seg.c0; i <= seg.c1; i++) hidden[i]++;
      }
    }
    const laneRows = Array.from({ length: visLanes }, () => 'var(--cal-lane-h)');
    if (overflow) laneRows.push('auto');
    const laneCount = visLanes + (overflow ? 1 : 0);
    const chipRows = Math.max(...week.map((date) => date ? (byDay.get(date) || []).length : 0), 0);
    const chipRow = laneCount + 2;
    const row = el('div', {
      class: 'cal-week',
      style: `grid-template-rows:auto ${laneRows.join(' ')} 1fr;min-height:${laneCount || chipRows ? 68 : 74}px`.replace(/\s+/g, ' '),
    });

    // ① 日期格：占满整行高度，是背景、边框与拖拽命中面
    week.forEach((date, i) => {
      const cls = ['cal-cell'];
      if (!date) {
        row.append(el('div', { class: 'cal-cell other', style: `grid-column:${i + 1}` }));
        return;
      }
      const wd = new Date(date + 'T00:00:00Z').getUTCDay();
      const hk = data.holidays?.[date]; // holiday | workday
      if (date.slice(0, 7) !== current) cls.push('other');
      if (date === today) cls.push('today');
      if (hk === 'holiday') cls.push('holiday');
      else if (hk === 'workday') cls.push('workday');
      else if (wd === 0 || wd === 6) cls.push('weekend');
      row.append(el('div', {
        class: cls.join(' '), 'data-date': date, style: `grid-column:${i + 1}`,
      }));
    });

    // ② 日期数字：第 1 行，与车道对齐的锚（原来嵌在格内，会随格内内容漂移）
    week.forEach((date, i) => {
      if (!date) return;
      const hk = data.holidays?.[date];
      row.append(el('div', {
        class: `cal-daynum${date.slice(0, 7) !== current ? ' other' : ''}${date === today ? ' is-today' : ''}`,
        style: `grid-column:${i + 1};grid-row:1`,
      },
        el('span', {}, String(Number(date.slice(8)))),
        hk ? el('span', { class: 'hmark' }, hk === 'holiday' ? '休' : '班') : null
      ));
    });

    // ③ 车道长条：跨列一条到底，同一周行内恒等高
    for (const seg of segs) {
      if (overflow && seg.lane >= visLanes) continue;
      row.append(taskSpanNode(seg, monthStart, monthLast));
    }

    if (overflow) {
      hidden.forEach((count, i) => {
        if (!count || !week[i]) return;
        row.append(el('button', {
          class: 'cal-more', type: 'button',
          style: `grid-column:${i + 1};grid-row:${visLanes + 2}`,
          'aria-label': `展开第 ${w + 1} 周隐藏的 ${count} 条待办`,
          onclick: () => { expanded.add(w); void load({ refresh: false }); },
        }, `+${count} 条`));
      });
    } else if (open && total > cap) {
      row.append(el('button', {
        class: 'cal-more cal-more-collapse', type: 'button',
        style: `grid-column:7;grid-row:${total + 2}`,
        'aria-label': `收起第 ${w + 1} 周待办`,
        onclick: () => { expanded.delete(w); void load({ refresh: false }); },
      }, '收起'));
    }

    // ④ chip 堆：车道区下方的末行
    week.forEach((date, i) => {
      const entries = date ? (byDay.get(date) || []) : [];
      if (!entries.length) return;
      row.append(el('div', {
        class: 'cal-day-chips',
        style: `grid-column:${i + 1};grid-row:${chipRow}`,
      }, ...entries.map((entry) => entry.node)));
    });

    grid.append(row);
  }
  renderTray(data.unplanned_tasks);
}

document.getElementById('prev').addEventListener('click', () => { expanded.clear(); current = shiftMonth(current, -1); load(); });
document.getElementById('next').addEventListener('click', () => { expanded.clear(); current = shiftMonth(current, 1); load(); });
document.getElementById('today-btn').addEventListener('click', () => { expanded.clear(); current = todayStr().slice(0, 7); load(); });
window.addEventListener('resize', syncResponsiveCopy, { passive: true });

// 图例即筛选开关：点击切 .off → 写 localStorage → 重渲染。
// 初始 .off 态与 filters 对齐（首次进入时按持久化偏好点亮/熄灭）。
for (const btn of document.querySelectorAll('.cal-legend .lg[data-key]')) {
  const key = btn.dataset.key;
  btn.setAttribute('role', 'switch');
  btn.setAttribute('aria-checked', String(filters[key]));
  if (!filters[key]) btn.classList.add('off');
  btn.addEventListener('click', () => {
    filters[key] = !filters[key];
    btn.classList.toggle('off', !filters[key]);
    btn.setAttribute('aria-checked', String(filters[key]));
    writeFilters(filters);
    load({ refresh: false });
  });
}

document.addEventListener('anjian:changed', load);
syncResponsiveCopy();
await load();
