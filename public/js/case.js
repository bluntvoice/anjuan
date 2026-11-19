import {procedureLabel} from './case-types.js';
import { mountCriminalFields } from './criminal-fields.js';
// 案件详情。DOM 契约见 case.html —— 改这里必须对着那里改。
// 设计体系 v2「一个骨架 · 三种材质」：面板 .panel/.p-head/.p-foot、期限跑道（母题）、
// 待办 .todo-row、款项 .pay-row、时间线 .tl-*。样式一律走 css/style.css 的类，不写内联样式
// （唯一例外：跑道时间轴的百分比几何 —— 颜色仍走 var()）。
import { api, el, toast, SEV_LABEL, STATUS_LABEL, todayStr } from './api.js';
import { mountNav, mayWriteCases } from './nav.js';
import { stepper } from './charts.js';
import { datePrompt } from './dateedit.js';
import { fileIconEl } from './icons.js';
import { bindFold, setFoldOpen } from './fold.js';
import { setLawTexts, basisBtn } from './deadline-basis.js';

import { mountCaseRecords } from './case-records.js';

const user = await mountNav();
const canWrite = mayWriteCases(user);
const canAudit = user.role_key === 'admin';

const id = new URLSearchParams(location.search).get('id');
if (!/^[1-9][0-9]*$/u.test(id || '') || !Number.isSafeInteger(Number(id))) {
  location.replace('/cases.html');
  throw new Error('案件编号不正确');
}

function arrangeCaseLayout() {
  const layout = document.getElementById('case-layout');
  const sections = [...layout.children];
  const lane = (name) => el('div', { class: `case-lane case-lane-${name}` },
    ...sections
      .filter((section) => section.classList.contains(`case-${name}`))
      .sort((a, b) => Number(a.dataset.caseOrder) - Number(b.dataset.caseOrder))
  );
  layout.replaceChildren(lane('main'), lane('side'));
  layout.classList.add('is-arranged');
}

function initCaseFolds() {
  // 归档门：details.archive-door，复用 fold.js 持久化
  bindFold(document.getElementById('case-archive-door'), `case-${id}-archive`, false);
  // 变更记录门：默认收起——它是底账不是工作台，平时不该占版面
  bindFold(document.getElementById('case-changes-fold'), `case-${id}-changes`, false);
  const archiveDoor = document.getElementById('case-archive-door');
  archiveDoor.addEventListener('toggle', () => {
    const caret = archiveDoor.querySelector('.archive-door-caret');
    if (caret) caret.textContent = archiveDoor.open ? '▾' : '▸';
  });

  // 三条事实条：「展开/收起」就地展开同条内的录入区（.factstrip-more），不走 fold.js
  const bindStrip = (toggleId, moreId) => {
    const toggle = document.getElementById(toggleId);
    const more = document.getElementById(moreId);
    if (!toggle || !more) return;
    toggle.addEventListener('click', () => {
      const open = more.hasAttribute('hidden');
      if (open) more.removeAttribute('hidden'); else more.setAttribute('hidden', '');
      toggle.classList.toggle('is-active', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = open ? '收起' : '展开';
    });
  };
  bindStrip('case-contacts-toggle', 'case-contacts-more');
}

function initSectionNav() {
  const links = [...document.querySelectorAll('#case-section-nav [data-target]')].filter(link => !link.hidden);
  const byId = new Map(links.map((link) => [link.dataset.target, link]));
  const setActive = (idToActivate) => {
    for (const link of links) link.classList.toggle('is-active', link.dataset.target === idToActivate);
  };
  const openTarget = (targetId, scroll = false) => {
    const target = document.getElementById(targetId);
    if (!target) return;
    // 命中的目标若是折叠门（.fold 或 .archive-door）或含折叠门，全部展开
    const isDoor = target.matches('details.fold, details.archive-door');
    const folds = isDoor ? [target] : [...target.querySelectorAll('details.fold, details.archive-door')];
    for (const details of folds) setFoldOpen(details, true, { persist: false });
    if (scroll) requestAnimationFrame(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  const applyHash = (scroll = false) => {
    const targetId = decodeURIComponent(location.hash.slice(1)) || 'case-overview';
    setActive(byId.has(targetId) ? targetId : (targetId.startsWith('case-') ? targetId : 'case-overview'));
    openTarget(targetId, scroll);
  };
  applyHash(false);
  for (const link of links) {
    link.addEventListener('click', () => {
      setActive(link.dataset.target);
      openTarget(link.dataset.target, true);
    });
  }
  window.addEventListener('hashchange', () => applyHash(true));
  const observer = new IntersectionObserver((entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (visible) setActive(visible.target.id);
  }, { rootMargin: '-150px 0px -62% 0px', threshold: [0, 0.05] });
  for (const target of byId.keys()) {
    const section = document.getElementById(target);
    if (section) observer.observe(section);
  }
}

const meta = await api('/case-options');
const evLabel = Object.fromEntries(meta.event_types.map(t => [t.id, t.label]));
setLawTexts(meta.law_texts);

// 编辑案件信息：程序 → 阶段联动（与建案表单同一模式）。改名/改程序是「录错了」的自救口。
const efProc = document.querySelector('#edit-form [name="procedure"]');
const efStage = document.querySelector('#edit-form [name="stage"]');
efProc.append(el('option', { value: '' }, '程序待补'));
for (const p of Object.keys(meta.procedures)) efProc.append(el('option', { value: p }, procedureLabel(p)));
function syncEditStages(stage) {
  efStage.replaceChildren();
  if (stage === '') efStage.append(el('option', { value: '' }, '阶段待补'));
  for (const s of meta.procedures[efProc.value] || []) efStage.append(el('option', { value: s }, s));
  // 当前阶段不在新程序词表里（历史自定义阶段）时保留显示，避免静默改成第一阶段
  if (stage && ![...efStage.options].some((o) => o.value === stage)) efStage.append(el('option', { value: stage }, stage));
  efStage.value = stage || efStage.options[0]?.value || '';
}
efProc.addEventListener('change', () => syncEditStages());
const criminalForm = mountCriminalFields(document.getElementById('edit-criminal-fields'), meta, efProc, efStage);

let bundle = null;
const TIMELINE_PREVIEW_LIMIT = 5;
let timelineExpanded = false;
let timelineItems = [];
let timelineFilter = 'all';

const daysTo = (dateStr, today = todayStr()) => Math.round((new Date(dateStr) - new Date(today)) / 86400000);

let caseSaving = false;
async function patchCase(fields, message = '已保存') {
  if (!canWrite || caseSaving) return false;
  caseSaving = true;
  const url = '/cases/' + id;
  const body = { ...fields, version: bundle.case.version };
  try {
    let result = await api(url, { method: 'PATCH', body });
    if (result.needs_confirm) {
      const { retire, protected: protectedRows } = result.condition_preview;
      if (!confirm('将作废 ' + retire.length + ' 条自动期限，保留 ' + protectedRows.length
        + ' 条人工期限。请核对后确认：\n' + retire.map(d => d.name).join('\n'))) return false;
      result = await api(url, { method: 'PATCH', body: { ...body, confirm_rederive: true } });
      if (result.needs_confirm) return false;
    }
    if (result.templated?.length) message += ' · 新增 ' + result.templated.length + ' 条模板待办';
    if (result.stage_change_log) message += ' · 已记入时间线';
    toast(message);
    await load().catch(() => {});
    return true;
  } catch {
    // A rejected write leaves the form and its expected version intact.
    return false;
  } finally {
    caseSaving = false;
  }
}

const CASE_STATUS_LABEL = { active: '在办', shelved: '搁置', closed: '已结' };
const ROLE_PILL = { 当事人: 'ok', 对方当事人: 'warn', 承办法官: 'acc', 法官助理: 'acc', 对方律师: 'warn', 合作律师: 'acc' };
const caseRecords = mountCaseRecords({ id, canWrite, canAudit, options: meta, reloadCase: load });

if (canWrite) {
  document.getElementById('c-status').addEventListener('change', async event => {
    const input = event.currentTarget;
    const next = input.value;
    if (next === bundle.case.status) return;
    if (next !== 'active' && !confirm('把案件状态改为「' + CASE_STATUS_LABEL[next] + '」？')) {
      input.value = bundle.case.status;
      return;
    }
    input.disabled = true;
    try { await patchCase({ status: next }, '状态已变更'); }
    finally { input.value = bundle.case.status; input.disabled = false; }
  });
  document.getElementById('edit-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const changed = Object.fromEntries([...new FormData(form)].filter(([field, value]) =>
      value !== String(bundle.case[field] ?? '')));
    if (!Object.keys(changed).length) return;
    if (changed.procedure && !Object.hasOwn(changed, 'stage')) changed.stage = form.elements.stage.value;
    const button = event.submitter;
    button.disabled = true;
    try { await patchCase(changed); } finally { button.disabled = false; }
  });
}

function contactRow(p) {
  return el('div', { class: 'row' },
    el('span', { class: 'pill ' + (ROLE_PILL[p.role] || '') }, p.role),
    el('b', {}, p.name),
    p.phone ? el('span', { class: 'meta nowrap' }, p.phone) : null,
    p.id_no ? el('span', { class: 'meta nowrap' }, p.id_no) : null,
    el('span', { class: 'grow meta' }, [p.org, p.note].filter(Boolean).join('｜')),
    canWrite ? el('button', { class: 'btn small', type: 'button', onclick: () => caseRecords.editContact(p) }, '编辑联系人') : null
  );
}

// ---- 期限跑道（本设计的母题：今日 → 死线）----
// 16 日刻度 = 逾期 2 日 + 今日 + 未来 14 日；今日原点固定 12.5%，每日 6.25%。
// 只有这里用内联 style：跑道几何是数据驱动的百分比，颜色仍全部走 var()。
const TRK_STEP = 6.25;
const TRK_ORIGIN = 12.5;

function track(d) {
  const days = d.days_left;
  const trk = el('div', {
    class: 'trk',
    title: days < 0
      ? `逾期 ${-days} 日 —— 死线 ${d.due_on} 已落在今日原点左侧`
      : days === 0 ? `今日截止 —— ${d.due_on}` : `剩 ${days} 日 —— 今日到死线 ${d.due_on}`,
  });
  if (days < 0) {
    const w = Math.min(-days, 2) * TRK_STEP;   // 逾期段向原点左侧反向延伸，封顶 2 日
    trk.append(
      el('i', { class: 'trk-fill over', style: `left:${TRK_ORIGIN - w}%;width:${w}%` }),
      el('i', { class: 'trk-origin' }),
      el('i', { class: 'trk-dot crit', style: `left:${TRK_ORIGIN - w}%` })
    );
    return trk;
  }
  const w = Math.min(days, 14) * TRK_STEP;     // 未来段封顶 14 日（刻度尺右端）
  trk.append(
    el('i', { class: `trk-fill ${days <= 7 ? 'warn' : 'ok'}`, style: `left:${TRK_ORIGIN}%;width:${w}%` }),
    el('i', { class: 'trk-origin' }),
    el('i', { class: `trk-dot ${days <= 3 ? 'crit' : days <= 7 ? 'warn' : 'ok'}`, style: `left:${TRK_ORIGIN + w}%` })
  );
  return trk;
}

function deadlineMeta(d) {
  const rolled = d.rolled_from && d.rolled_from < d.due_on;
  return [
    el('span', {}, SEV_LABEL[d.severity] || '一般'),
    d.basis ? el('span', { class: 'sep' }, '·') : null,
    basisBtn(d),
    d.is_manual_override ? el('span', { class: 'sep' }, '·') : null,
    d.is_manual_override ? el('span', {}, '人工设定') : null,
    d.review_status === 'pending_review' ? el('span', { class: 'sep' }, '·') : null,
    d.review_status === 'pending_review' ? el('span', { class: 'pill review' }, 'AI 填 · 待核') : null,
    d.calc_note?.includes('节假日数据缺') ? el('span', { class: 'pill warn', title: d.calc_note }, '⚠️') : null,
    rolled ? el('span', { class: 'pill warn' }, `原届满 ${d.rolled_from} 逢节假日，已顺延至 ${d.due_on} · 建议节前办`) : null,
  ];
}

const CRIMINAL_ROLL_NOTE = '刑诉法§105②：期间的最后一日为节假日的，以节假日后的第一日为期满日期，但犯罪嫌疑人、被告人或者罪犯在押期间，应当至期满之日为止，不得因节假日而延长。本规则默认不顺延（2026-09-11 决定）；如当事人未在押，可选择按§105顺延。';

function criminalRollBox(d) {
  const option = d.holiday_roll_option;
  if (!option?.applies) return null;
  return el('details', { class: 'criminal-roll-box' },
    el('summary', {}, '刑诉法§105顺延说明'),
    el('div', {}, '默认不顺延：' + option.default_due + ' · 顺延：' + option.rolled_due),
    el('p', {}, CRIMINAL_ROLL_NOTE)
  );
}

// 头条：本案最近的那条死线。只在「真该喊」时出现（逾期或 ≤7 日）——
// 否则一条 60 天后的期限也顶着红色巨字，是虚假警报。
function runwayLead(d) {
  const days = d.days_left;
  const over = days < 0;
  return el('div', { class: 'rw-lead' + (!over && days > 3 ? ' amb' : '') },
    el('div', { class: 'hd-main' },
      el('div', { class: 'hd-kick' }, over ? '最近死线 · 已逾期' : days === 0 ? '最近死线 · 今日截止' : '最近死线'),
      el('div', { class: 'hd-num' },
        el('span', { class: 'w' }, over ? '逾期' : '剩'),
        el('span', { class: 'n' }, String(Math.abs(days))),
        el('span', { class: 'w' }, '天')
      ),
      el('h3', { class: 'hd-deck' }, d.name),
      el('div', { class: 'hd-rule', 'aria-hidden': 'true' }),
      el('div', { class: 'hd-meta' },
        el('span', {}, `${d.due_on} 到期`),
        el('span', { class: 'sep' }, '·'),
        ...deadlineMeta(d),
        d.calc_note ? el('span', { class: 'sep' }, '·') : null,
        d.calc_note ? el('span', {}, d.calc_note) : null
      ),
      criminalRollBox(d)
    ),
    el('div', { class: 'rw-trk' }, track(d)),
    el('div', { class: 'rw-due' }, d.due_on.slice(5))
  );
}

// 紧凑跑道行。字号梯度 28 → 20 → 15（d1/d2/d3）＝ 信息层级：越靠前越急。
function runwayRow(d, i) {
  const days = d.days_left;
  const over = days < 0;
  const tone = (over || days <= 3) ? ' crit' : days <= 7 ? ' amb' : '';
  const size = i === 0 ? ' d1' : i === 1 ? ' d2' : ' d3';
  return el('div', { class: `rw-row${size}${tone}` },
    el('div', { class: 'rw-days' },
      el('span', { class: 'pre' }, over ? '逾期' : '剩'),
      el('span', { class: 'n' }, String(Math.abs(days))),
      el('span', { class: 'u' }, '天')
    ),
    el('div', { class: 'rw-main' },
      el('div', { class: 'm1' }, d.name),
      el('div', { class: 'm2' }, ...deadlineMeta(d)),
      criminalRollBox(d)
    ),
    el('div', { class: 'rw-trk' }, track(d)),
    el('div', { class: 'rw-due' }, d.due_on.slice(5))
  );
}

function advisoryRunwayRow(d, i) {
  return el('div', { class: `rw-row advisory-row d${Math.min(i + 1, 3)}` },
    el('div', { class: 'rw-days advisory-days' }, el('span', { class: 'pre' }, '参考')),
    el('div', { class: 'rw-main' },
      el('div', { class: 'm1' }, d.name),
      el('div', { class: 'm2' }, el('span', { class: 'pill' }, '参考 · 非约束'),
        el('span', { class: 'sep' }, '·'), el('span', {}, `到期 ${d.due_on}`)),
      criminalRollBox(d),
    ),
    el('div', { class: 'rw-due' }, d.due_on.slice(5))
  );
}

function advisoryRunway(items) {
  const wrap = el('div', { class: 'runway runway-act advisory-runway' },
    el('div', { class: 'rw-colhead' },
      el('span', { class: 'h-days' }, '参考'),
      el('span', { class: 'h-item' }, '参考期限 · 非约束'),
      el('span', { class: 'h-trk' }, ''),
      el('span', { class: 'h-due' }, '到期')
    ),
  );
  items.forEach((d, i) => wrap.append(advisoryRunwayRow(d, i)));
  return wrap;
}

function caseRunway(items) {
  const wrap = el('div', { class: 'runway runway-act' },
    el('div', { class: 'rw-colhead' },
      el('span', { class: 'h-days' }, '剩余'),
      el('span', { class: 'h-item' }, '事项 · 级别 · 依据'),
      el('span', { class: 'h-trk' }, '今日 → 死线'),
      el('span', { class: 'h-due' }, '到期')
    )
  );
  const lead = items[0].days_left <= 7 ? items[0] : null;
  if (lead) wrap.append(runwayLead(lead));
  (lead ? items.slice(1) : items).forEach((d, i) => wrap.append(runwayRow(d, i)));
  return wrap;
}

// ---- 费用 ----
function taskRow(t) {
  const dl = t.due_on ? daysTo(t.due_on) : null;
  const dueCls = dl === null ? '' : dl < 0 ? 'chip c-red' : dl <= 3 ? 'chip c-amber' : 'chip';
  const urgencyClass = dl === null ? '' : dl < 0 ? ' is-overdue' : dl <= 3 ? ' is-soon' : '';
  return el('div', { class: 'todo-row' + urgencyClass },
    el('span', { class: 't-text' }, t.title),
    el('span', { class: 't-chips' },
      t.priority === 'high' ? el('span', { class: 'pill crit' }, '优先') : null,
      t.origin !== 'manual' ? el('span', { class: 'pill acc' }, t.origin === 'llm' ? 'AI' : '模板') : null,
      t.plan_date ? el('span', { class: 'chip' }, `计划 ${t.plan_date.slice(5)}`) : null,
      t.due_on ? el('span', { class: dueCls }, `截止 ${t.due_on.slice(5)}`) : null
    ),
  );
}

function tlItem(date, nodeCls, kindPill, bodyEls, actions = null, extraClass = '') {
  return el('div', { class: `tl-item ${extraClass}`.trim() },
    el('span', { class: `tl-node ${nodeCls}`, 'aria-hidden': 'true' }),
    el('span', { class: 'tl-date' }, date),
    el('div', { class: 'tl-body' }, kindPill, ' ', ...bodyEls),
    actions ? el('span', { class: 'tl-actions' }, actions) : null
  );
}

function attachmentsFor(entity, entityId) {
  const list = (bundle.attachments || []).filter((a) => a.entity === entity && a.entity_id === entityId);
  if (!list.length) return [];
  return [el('div', { class: 't-chips' },
    ...list.map((a) => el('a', {
      class: 'chip',
      href: `/api/cases/${id}/file?path=` + encodeURIComponent(a.rel_path),
      target: '_blank', rel: 'noopener', title: a.rel_path,
    }, a.filename))
  )];
}

function drawTimeline(nextItems = timelineItems) {
  timelineItems = nextItems;
  const sourceTotal = timelineItems.length;
  const filtered = timelineFilter === 'all'
    ? timelineItems
    : timelineItems.filter((item) => item.kind === timelineFilter);
  const total = filtered.length;
  if (total <= TIMELINE_PREVIEW_LIMIT) timelineExpanded = false;

  const visible = timelineExpanded ? filtered : (() => {
    return filtered.filter((item, i) => i < TIMELINE_PREVIEW_LIMIT || item.keepVisible);
  })();
  const tl = document.getElementById('timeline');
  tl.replaceChildren(...visible.map((item) => item.build()));
  if (!total) {
    tl.append(el('div', { class: 'section-empty' },
      el('span', {}, timelineFilter === 'all' ? '还没有记录' : '这个筛选下没有记录'),
      el('button', {
        class: 'btn small panel-quick-action', type: 'button',
        'aria-controls': 'log-form',
        onclick: () => revealRecordForm('log-form'),
      }, '记一条工作日志')
    ));
  }

  document.getElementById('timeline-meta').textContent = timelineFilter === 'all'
    ? (total ? `${total} 条` : '事件 · 期限 · 日志')
    : `${total} / ${sourceTotal} 条`;
  const controls = document.getElementById('timeline-controls');
  const toggle = document.getElementById('timeline-toggle');
  const state = document.getElementById('timeline-visible-meta');
  controls.hidden = total <= TIMELINE_PREVIEW_LIMIT;
  toggle.setAttribute('aria-expanded', String(timelineExpanded));
  if (controls.hidden) {
    toggle.textContent = '展开全部';
    state.textContent = '';
    return;
  }
  toggle.textContent = timelineExpanded
    ? `收起，仅看最近 ${TIMELINE_PREVIEW_LIMIT} 条及待处理参考期限`
    : `展开全部（${total} 条）`;
  state.textContent = timelineExpanded
    ? `已显示全部 ${total} 条`
    : `已显示 ${visible.length} / 共 ${total} 条（含待处理参考期限）`;
}

for (const button of document.querySelectorAll('[data-timeline-filter]')) {
  button.addEventListener('click', () => {
    timelineFilter = button.dataset.timelineFilter;
    timelineExpanded = false;
    for (const item of document.querySelectorAll('[data-timeline-filter]')) {
      item.classList.toggle('is-active', item === button);
    }
    drawTimeline();
  });
}

document.getElementById('timeline-toggle').addEventListener('click', (event) => {
  const toggle = event.currentTarget;
  timelineExpanded = !timelineExpanded;
  drawTimeline();
  requestAnimationFrame(() => toggle.scrollIntoView({ behavior: 'auto', block: 'nearest' }));
});

function renderElapsed(items) {
  const section = document.getElementById('case-elapsed');
  const list = document.getElementById('elapsed-list');
  if (!section || !list) return;
  section.hidden = !items.length;
  list.replaceChildren(...items.map((item) => el('div', { class: 'elapsed-item' },
    el('div', {}, el('b', {}, item.event_label), ` · ${item.occurred_on} · ${item.elapsed_text}`),
    el('div', { class: 'elapsed-reminders' }, ...item.reminders.map((reminder) => {
      const duration = reminder.label.match(/\d+(?:\.\d+)?\s*(?:个月|年|天)/)?.[0] || reminder.label;
      return el('span', {
        class: `pill elapsed-reminder ${reminder.reached ? 'is-reached' : ''}`,
        title: reminder.reached ? reminder.label : '',
      }, reminder.reached ? `已满 ${duration}` : `${duration}提醒 ${reminder.due_on}`);
    })),
  )));
}

// ---- 渲染 ----
function render() {
  const c = bundle.case;
  const isAdminCase = String(c.procedure || '').startsWith('行政') || c.case_type === '行政';
  document.title = `${c.name} · 案卷`;
  document.getElementById('title').textContent = c.name;
  document.getElementById('subtitle').textContent =
    [c.case_no, c.cause, c.court, c.client && `${c.client}（${c.client_role || '我方'}）`, c.opponent && `对方：${c.opponent}`]
      .filter(Boolean).join(' · ') || '信息待补';

  // 阶段步进器（点步进节点切换阶段）
  const stageStepper = stepper(bundle.stages, c.stage, canWrite ? async (s) => {
    if (s === c.stage) return;
    if (!confirm(`把阶段从「${c.stage}」切换到「${s}」？`)) return;
    await patchCase({ stage: s }, '阶段已变更 ✓');
  } : null);
  stageStepper.classList.add('stepper-vertical');
  document.getElementById('stepper-box').replaceChildren(stageStepper);
  document.getElementById('c-status').value = c.status;
  document.getElementById('case-status').textContent = '状态 · ' + (CASE_STATUS_LABEL[c.status] || c.status);
  document.getElementById('case-status').hidden = canWrite;
  const sd = document.getElementById('c-stagedays');
  sd.replaceChildren(c.stage_days == null ? '阶段起算日待补' : `本阶段已停留 ${c.stage_days} 天`);
  if (c.stage_days > 30) sd.append(el('span', { class: 'chip c-amber' }, '偏久 · 考虑推进或核对状态'));
  const sourceInfo = document.getElementById('case-source-info');
  sourceInfo.hidden = !c.note;
  document.getElementById('case-source-text').textContent = c.note || '';

  const ef = document.getElementById('edit-form');
  for (const f of ['name', 'case_type', 'case_no', 'cause', 'court', 'client', 'client_role', 'opponent', 'accepted_at', 'sol_starts_on', 'note', 'reconsideration_precondition']) {
    if (ef.elements[f]) ef.elements[f].value = c[f] || '';
  }
  const preconditionField = document.getElementById('reconsideration-precondition-field');
  preconditionField.hidden = !isAdminCase;
  efProc.value = c.procedure;
  syncEditStages(c.stage);
  criminalForm.fill(c);
  const warnings = document.getElementById('condition-warnings');
  warnings.hidden = !(bundle.condition_warnings || []).length;
  warnings.textContent = (bundle.condition_warnings || []).length ? `期限待补条件：${bundle.condition_warnings.map(w => w.label).join('、')}。请编辑案件信息；已有期限并不代表期限已齐全。` : '';
  const preconditionWarning = document.getElementById('precondition-warning');
  const preconditionHint = document.getElementById('precondition-hint');
  preconditionWarning.hidden = !(isAdminCase && c.reconsideration_precondition === 'yes');
  preconditionWarning.textContent = preconditionWarning.hidden ? '' : '⚠️ 复议前置：本案须先申请行政复议，对复议决定不服再起诉（行政复议法§23）。未经复议直接起诉的，人民法院裁定不予立案（法释〔2018〕1号§56）；已经立案的，裁定驳回起诉（同解释§69①(五)）。直接起诉期限已停用，起诉期限以复议决定送达/复议期满起算（行政诉讼法§45、行政复议法§34）。';
  const PRECONDITION_YES_EVENT_TYPES = new Set(['admin_duty_applied','admin_penalty_on_spot','admin_natural_resource_decision','admin_gov_info_not_disclosed']);
  const hasPreconditionCue = (bundle.events || []).some((ev) => PRECONDITION_YES_EVENT_TYPES.has(ev.type));
  preconditionHint.hidden = !(isAdminCase && c.reconsideration_precondition === 'unknown' && hasPreconditionCue);
  preconditionHint.textContent = preconditionHint.hidden ? '' : '⚠️ 本案记录了可能属于复议前置的事件（当场处罚／自然资源／履职申请／信息公开不予公开等），请确认「复议前置」是/否。';
  renderElapsed(bundle.elapsed || []);
  // 联系人
  const cbox = document.getElementById('contact-list');
  cbox.replaceChildren(...(bundle.contacts || []).map(contactRow));
  if (!(bundle.contacts || []).length) cbox.append(el('div', { class: 'section-empty' }, '尚未登记——当事人、承办法官、法官助理都记在这里'));
  const contacts = bundle.contacts || [];
  const firstContact = (...roles) => contacts.find((contact) => roles.includes(contact.role))?.name || '';
  const contactSummary = [
    `委托人 ${c.client || firstContact('当事人') || '待补'}`,
    `对方 ${c.opponent || firstContact('对方当事人') || '待补'}`,
    `代理人 ${firstContact('合作律师', '对方律师') || '待补'}`,
  ].join(' · ');
  document.getElementById('contact-summary').textContent = contactSummary;
  const participants = bundle.participants || [];
  document.getElementById('case-participant-summary').textContent = participants.length ? participants.length + ' 人' : '未登记';
  document.getElementById('case-participant-list').replaceChildren(...participants.map(p =>
    el('div', { class: 'row' }, el('b', {}, p.name), p.role, p.org)));
  document.getElementById('attachment-list').replaceChildren(...bundle.attachments.map(a =>
    el('div', { class: 'row' }, caseRecords.fileLinks(a.rel_path))));
  if (!bundle.attachments.length) document.getElementById('attachment-list').textContent = '暂无附件引用';

  // 本案期限跑道（母题）
  const today = todayStr();
  const pend = bundle.deadlines
    .filter((x) => x.status === 'pending' && !x.advisory)
    .map((x) => ({ ...x, days_left: daysTo(x.due_on, today) }))
    .sort((a, b) => a.days_left - b.days_left);
  const advisoryPend = bundle.deadlines
    .filter((x) => x.status === 'pending' && x.advisory)
    .map((x) => ({ ...x, days_left: daysTo(x.due_on, today) }))
    .sort((a, b) => a.days_left - b.days_left);

  const nextDeadline = pend[0];
  const deadlineHead = document.getElementById('case-head-deadline');
  deadlineHead.replaceChildren(nextDeadline
    ? el('div', { class: `case-head-deadline-card${nextDeadline.days_left < 0 ? ' is-overdue' : ''}` },
      el('a', { href: '#case-actions' },
        el('span', {}, '下一期限'),
        el('b', {}, nextDeadline.name),
        el('strong', { class: 'num' }, nextDeadline.days_left < 0
          ? `逾期 ${Math.abs(nextDeadline.days_left)} 日`
          : nextDeadline.days_left === 0 ? '今日截止' : `剩 ${nextDeadline.days_left} 日`)
      )
    )
    : el('span', { class: 'is-clear' }, '当前无在追期限'));

  const runwayBlocks = [];
  if (pend.length) runwayBlocks.push(caseRunway(pend));
  if (advisoryPend.length) runwayBlocks.push(advisoryRunway(advisoryPend));
  if (!runwayBlocks.length) runwayBlocks.push(el('div', { class: 'section-empty' }, '无在追期限'));
  document.getElementById('case-runway').replaceChildren(...runwayBlocks);
  document.getElementById('runway-legend').hidden = !pend.length;
  const rwMeta = document.getElementById('runway-meta');
  rwMeta.replaceChildren();
  if (pend.length) {
    const over = pend.filter((x) => x.days_left < 0).length;
    rwMeta.append(
      el('span', {}, '按剩余天数升序'),
      el('span', { class: 'sep' }, '·'),
      el('span', { class: 'm' }, `${pend.length} 项`)
    );
    if (over) rwMeta.append(el('span', { class: 'sep' }, '·'), el('span', { class: 'm hot' }, `${over} 逾期`));
  }

  // 未结待办
  const open = bundle.tasks.filter((t) => t.status === 'open');
  const tbox = document.getElementById('open-tasks');
  tbox.replaceChildren(...open.map(taskRow));
  if (!open.length) tbox.append(el('div', { class: 'section-empty' }, '无未结待办'));
  document.getElementById('tasks-count').textContent = open.length ? `${open.length} 项` : '';
  document.getElementById('case-action-badge').textContent = pend.length + advisoryPend.length + open.length || '';

  // 时间线合流：event / deadline / worklog
  const items = [
    ...bundle.events.map((e) => ({ kind: 'event', date: e.occurred_on, sort2: 2, build: () => tlItem(e.occurred_on, 'tl-node-event',
      el('span', { class: 'pill acc' }, evLabel[e.type] || e.type),
      [
        ['llm', 'ai'].includes(e.created_by) ? el('span', { class: 'pill acc' }, 'AI 加的') : null,
        (e.occurred_time || e.location) ? el('span', { class: 'pill' },
          [e.occurred_time, e.location].filter(Boolean).join(' · ')) : null,
        e.instrument ? el('span', {}, e.instrument, ' ') : null,
        e.service_method ? el('span', { class: 'pill' }, e.service_method) : null,
        e.note ? el('div', { class: 'tl-note' }, e.note) : null,
        ...attachmentsFor('event', e.id),
      ],
    ) })),
    ...bundle.deadlines.map((d) => {
      const overdue = d.status === 'pending' && d.due_on < today;
      const nodeCls = d.advisory || d.status !== 'pending' ? 'tl-node-muted'
        : d.severity === 'critical' ? 'tl-node-crit' : d.severity === 'high' ? 'tl-node-warn' : 'tl-node-ok';
      const buildPill = () => d.advisory
        ? el('span', { class: 'pill', title: meta.advisory_notes[d.rule_id] || '' }, '参考 · 非约束')
        : d.status === 'pending'
        ? el('span', { class: `pill ${d.severity === 'critical' ? 'crit' : d.severity === 'high' ? 'warn' : 'ok'}` },
            `死线 · ${SEV_LABEL[d.severity]}${overdue ? ' · 已逾期' : ''}`)
        : el('span', { class: `pill ${d.status === 'done' ? 'ok' : ''}` }, `死线 · ${STATUS_LABEL[d.status]}`);
      return { kind: 'deadline', date: d.due_on, sort2: 1, keepVisible: d.status === 'pending' && !!d.advisory, build: () => tlItem(d.due_on, nodeCls, buildPill(),
        [
          el('b', {}, d.name), ' ',
          basisBtn(d),
          d.calc_note ? el('div', { class: 'tl-note' }, `算法：${d.calc_note}`) : null,
          criminalRollBox(d),
          d.suppressed_reason ? el('div', { class: 'tl-note' }, `已抑制：${d.suppressed_reason}`) : null,
          d.advisory ? el('span', { class: 'pill', title: meta.advisory_notes[d.rule_id] || '' }, '参考 · 非约束') : null,
          d.is_manual_override ? el('span', { class: 'pill' }, '人工设定') : null,
          d.review_status === 'pending_review' ? el('span', { class: 'pill review' }, 'AI 填 · 待核') : null,
          d.calc_note?.includes('节假日数据缺') ? el('span', { class: 'pill warn', title: d.calc_note }, '⚠️') : null,
        ],
        null,
        d.advisory ? 'deadline-advisory' : ''
      ) };
    }),
    ...bundle.worklog.map((w) => ({ kind: 'log', date: w.worked_on, sort2: 3, build: () => tlItem(w.worked_on, 'tl-node-log',
      el('span', { class: 'pill' }, '日志'),
      // AI 标签必须放进正文数组（同事件行）：tlItem 第 4 参是要展开的正文，插成独立位置参数会把
      // 正文挤到 actions 位、让 null 被展开，整页时间线崩溃（2026-10-13 真机验收抓到）。
      [w.created_by === 'ai' ? el('span', { class: 'pill acc' }, 'AI 加的') : null, w.content, w.minutes ? el('span', { class: 'tl-note' }, `（${w.minutes} 分钟）`) : null,
        w.artifacts ? el('div', { class: 'tl-note' }, `产物：${w.artifacts}`) : null],
    ) })),
  ];
  items.sort((a, b) => (b.date + b.sort2).localeCompare(a.date + a.sort2));
  drawTimeline(items);
}

// ---- 案件文件浏览器（读写配置的案件夹）----
let curDir = '';
let seenDir = null;
let seenFiles = null;
let fileRequest = 0;
const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

function setFileStatus(text, live) {
  const s = document.getElementById('file-status');
  if (!s) return;
  s.textContent = text;
  s.classList.toggle('is-live', !!live);
}

// T2 可见回落提示：secure-files 判定 folder_path 失效、回落到同名目录时，API 只在该次
// 响应里带 workspace_notice。文本一律走 textContent 防 XSS；style.css 属本轮冻结区，
// 复用三皮肤 amber 提示类 .money-notice（同 --amber/--amber-line/--amber-bg token）。
function renderWorkspaceNotice(notice) {
  const prev = document.getElementById('file-workspace-notice');
  if (!notice) { prev?.remove(); return; }
  const text = '⚠ ' + notice;
  if (prev) { prev.textContent = text; return; }
  const box = document.getElementById('file-list');
  const node = el('div', { id: 'file-workspace-notice', class: 'money-notice', role: 'status' });
  node.textContent = text;
  box.before(node);
}

async function loadFiles() {
  const box = document.getElementById('file-list');
  const crumbs = document.getElementById('file-crumbs');
  let d;
  const sequence = ++fileRequest;
  try {
    d = await api(`/cases/${id}/files?dir=` + encodeURIComponent(curDir));
  } catch {
    if (sequence !== fileRequest) return;
    renderWorkspaceNotice(null);
    box.replaceChildren(el('div', { class: 'section-empty' }, '文件根未配置或不可达'));
    setFileStatus('未连通', false);
    return;
  }
  if (sequence !== fileRequest) return;
  if (!d.exists) {
    renderWorkspaceNotice(null);
    box.replaceChildren(el('div', { class: 'section-empty' }, '案件夹不存在——核对 §9.3 文件夹名与 cases.name 是否一致'));
    crumbs.textContent = '';
    setFileStatus('无案件夹', false);
    return;
  }
  renderWorkspaceNotice(d.workspace_notice || null);
  // 面包屑
  crumbs.replaceChildren(
    el('a', { href: '#', onclick: (e) => { e.preventDefault(); curDir = ''; loadFiles(); } }, '案件根'),
    ...curDir.split('/').filter(Boolean).map((seg, i, arr) => el('span', {}, ' / ',
      el('a', { href: '#', onclick: (e) => { e.preventDefault(); curDir = arr.slice(0, i + 1).join('/'); loadFiles(); } }, seg)))
  );
  // 上传目录下拉
  const upDir = document.getElementById('up-dir');
  if (canWrite && !upDir.options.length) {
    for (const w of d.write_dirs) upDir.append(el('option', { value: w }, '→ ' + w));
  }
  const rows = [];
  for (const dir of d.dirs) {
    rows.push(el('div', { class: 'row row-dir' },
      fileIconEl(dir, true),
      el('a', { href: '#', class: 'grow', onclick: (e) => { e.preventDefault(); curDir = curDir ? curDir + '/' + dir : dir; loadFiles(); } }, dir),
      el('span', { class: 'meta nowrap' }, '目录')
    ));
  }
  // 首轮（或刚换目录）不标新：没有可比的基线
  const known = seenDir === curDir ? seenFiles : null;
  const now = new Set(d.files.map((f) => f.name));
  for (const f of d.files) {
    const rel = curDir ? curDir + '/' + f.name : f.name;
    const isNew = known && !known.has(f.name);
    rows.push(el('div', { class: 'row file-row' + (isNew ? ' row-new' : '') },
      fileIconEl(f.name),
      el('span', { class: 'grow file-name' }, f.name),
      ...(isNew ? [el('span', { class: 'chip chip-new' }, '新')] : []),
      el('span', { class: 'meta nowrap file-meta' }, fmtSize(f.size) + ' · ' + f.mtime),
      caseRecords.fileLinks(rel),
      canWrite ? el('button', { class: 'btn small', type: 'button', onclick: () => caseRecords.attach(rel) }, '登记附件') : null
    ));
  }
  seenDir = curDir;
  seenFiles = now;
  box.replaceChildren(...(rows.length ? rows : [el('div', { class: 'section-empty' }, '（空目录）')]));
  const t = new Date().toTimeString().slice(0, 5);
  setFileStatus('已刷新 ' + t, false);
  return d;
}

let uploading = false;
async function uploadInto(files, dir) {
  if (!canWrite || uploading || !dir) return;
  uploading = true;
  let complete = 0;
  try {
    for (const file of files) {
      try {
        const query = new URLSearchParams({ dir, name: file.name });
        const res = await fetch('/api/cases/' + id + '/files?' + query, {
          method: 'PUT', body: file, headers: { 'Content-Type': 'application/octet-stream' },
        });
        if (res.status === 401) { location.replace('/login.html'); return; }
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || '上传失败');
        complete++;
      } catch (error) { toast(file.name + '：' + error.message, 3200); }
    }
    if (complete) {
      toast('已上传 ' + complete + ' 份');
      curDir = dir;
      await loadFiles();
    }
  } finally { uploading = false; }
}

if (canWrite) document.getElementById('up-btn').addEventListener('click', async () => {
  const input = document.getElementById('up-files');
  const files = [...(input.files || [])];
  if (!files.length) { toast('先选择文件'); return; }
  await uploadInto(files, document.getElementById('up-dir').value);
  input.value = '';
});

document.getElementById('file-refresh')?.addEventListener('click', () => loadFiles());

// 拖拽入夹：拖到文件面板 = 上传到当前上传目录
const drop = document.getElementById('file-drop');
if (canWrite && drop) {
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let dragDepth = 0;
  drop.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    stop(e);
    dragDepth += 1;
    drop.classList.add('dropping');
  });
  drop.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    stop(e);
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    drop.classList.add('dropping');
  });
  drop.addEventListener('dragleave', (e) => {
    if (!drop.classList.contains('dropping')) return;
    stop(e);
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) drop.classList.remove('dropping');
  });
  drop.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    stop(e);
    dragDepth = 0;
    drop.classList.remove('dropping');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) await uploadInto(files, document.getElementById('up-dir').value);
  });
}

async function load() {
  bundle = await api('/cases/' + id);
  render();
}
await load();
if (canWrite) document.querySelectorAll('[data-case-write]').forEach(node => { node.hidden = false; });
if (canAudit) document.querySelectorAll('[data-case-audit]').forEach(node => { node.hidden = false; });
arrangeCaseLayout();
initCaseFolds();
initSectionNav();
await Promise.all([loadFiles(), caseRecords.load()]);
