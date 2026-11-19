import assert from 'node:assert/strict';
import { Element, loadDocument } from './renderer-dom.js';

const now = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
const caseRow = { id: 8, name: '合成案件甲', procedure: '一审', stage: '待受理', status: 'active', version: 7 };
const deadline = { id: 23, name: '合成期限', due_on: now, severity: 'critical', status: 'pending',
  days_left: 0, case_id: 8, case_name: caseRow.name, advisory: 0 };
const task = { id: 29, title: '合成待办', plan_date: now, due_on: now, due_time: '', status: 'open',
  priority: 'normal', origin: 'manual', case_id: 8, case_name: caseRow.name };
const options = { case_types: ['民事'], procedures: { 一审: ['待受理', '审查'] }, criminal_fields: [],
  contact_roles: ['其他'], stage_labels: [], event_types: [{ id: 'hearing', label: '开庭' }], law_texts: [], advisory_notes: {} };
const reads = {
  '/case-options': options,
  '/cases': [caseRow, { ...caseRow, id: 9, name: '合成案件乙', status: 'closed' }],
  '/cases/8': { case: caseRow, stages: options.procedures.一审, condition_warnings: [],
    events: [{ id: 27, type: 'hearing', occurred_on: now, note: '合成开庭' }],
    deadlines: [deadline], tasks: [task], worklog: [{ id: 31, worked_on: now, content: '合成日志' }],
    attachments: [{ id: 18, entity: 'event', entity_id: 27, rel_path: '证据整理/材料.txt' }],
    contacts: [{ id: 17, name: '合成联系人', role: '其他', version: 1 }], participants: [] },
  '/cases/8/facts': [{ id: 12, content: '合成事实', version: 1 }],
  '/cases/8/fees': { totals: { unpaid_fen: '1533', paid_fen: '0', legacy_count: 3 }, items: [
    { id: 1, agreed_amount: '17.03', payable_percent: '90.00', payable_amount: '15.33', status: 'unpaid', version: 3 },
    { id: 2, recorded_amount: '2.01', legacy: true, status: 'paid' },
    { id: 3, recorded_amount: null, legacy: true, status: 'unpaid' },
    { id: 4, recorded_amount: '0.00', legacy: true, status: 'unpaid' },
  ] },
  '/cases/8/files': { exists: true, dirs: ['证据整理'], files: [{ name: '材料.txt', size: 4, mtime: '合成时间' }],
    write_dirs: ['证据整理'] },
  '/case-dashboard/today': { date: now, counts: { active_cases: 2, open_tasks: 2 },
    red: [deadline], week: [], watch: [], hearings: [], today_tasks: [task], week_tasks: [],
    all_tasks: [task], no_deadline_cases: [] },
  '/users': { users: [] },
};

const storage = new Map();
let visit = 0;
async function page(html, module, role, search = '', override) {
  const requests = [];
  globalThis.document = loadDocument(new URL('../../public/' + html, import.meta.url));
  globalThis.window = new Element('window');
  window.matchMedia = globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.MutationObserver = globalThis.IntersectionObserver = class { observe() {} };
  globalThis.HTMLElement = Element;
  globalThis.requestAnimationFrame = callback => callback();
  globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  };
  globalThis.FormData = class {
    constructor(form) { this.fields = Object.entries(form.elements).filter(([, node]) => !node.disabled); }
    entries() { return this.fields.map(([name, node]) => [name, node.value])[Symbol.iterator](); }
    [Symbol.iterator]() { return this.entries(); }
  };
  globalThis.location = { pathname: '/' + html, search, hash: '', replace(value) { this.href = value; } };
  globalThis.fetch = async (destination, request = {}) => {
    const url = new URL(destination, 'http://127.0.0.1:18000');
    assert.equal(url.origin, 'http://127.0.0.1:18000');
    assert(url.pathname.startsWith('/api/'));
    const route = url.pathname.slice(4);
    const method = request.method ?? 'GET';
    requests.push({ method, route, query: url.search, body: request.body });
    let body;
    if (route === '/auth/me') body = { user: { display_name: '合成账号', role_key: role, version: 1 } };
    else if (route === '/logout') body = { ok: true };
    else if (route === '/cases/8/audit') body = {
      items: url.search ? [
        { id: 31, at: now, action: 'derive-deadline', entity: 'deadline', entity_id: 23, actor: 'synthetic' },
        { id: 28, at: now, action: 'derive-task', entity: 'task', entity_id: 29, actor: 'synthetic' },
      ] : [{ id: 31, at: now, action: 'derive-deadline', entity: 'deadline', entity_id: 23, actor: 'synthetic' }],
      next_before: url.search ? null : 31,
    };
    else if (route === '/case-dashboard/calendar') {
      const month = url.searchParams.get('month');
      body = { month, tasks: month === now.slice(0, 7) ? [task] : [], holidays: {}, hearings: [],
        deadlines: month === now.slice(0, 7) ? [deadline] : [],
        unplanned_tasks: [{ ...task, id: 30, title: '合成未排期', due_on: '', plan_date: '' }] };
    } else body = reads[route];
    const response = override?.(requests.at(-1));
    if (response) return Response.json(response.body, { status: response.status });
    assert.equal(method, route === '/logout' ? 'POST' : 'GET', 'unexpected method ' + route);
    assert(body, 'unexpected request ' + route);
    return Response.json(body);
  };
  await import('../../public/js/' + module + '.js?visit=' + ++visit);
  return requests;
}

const id = name => document.getElementById(name);
const paths = requests => requests.map(entry => entry.route);
const text = node => node.textContent.replace(/\s+/g, ' ').trim();
const flush = () => new Promise(resolve => setImmediate(resolve));
const scope = process.argv[2] ?? 'all';
assert(['all', 'w1', 'w2', 'w3'].includes(scope));

if (scope === 'all' || scope === 'w1') {
  for (const role of ['admin', 'editor', 'viewer']) {
    const requests = await page('cases.html', 'cases', role, '', entry => entry.method === 'POST' && entry.route === '/cases'
      ? { status: 201, body: { id: 10 } } : null);
    assert.deepEqual(paths(requests), ['/auth/me', '/case-options', '/cases']);
    assert.equal(id('new-case').hidden, role === 'viewer');
    assert.deepEqual(document.querySelectorAll('.case-card').map(card => card.getAttribute('href')),
      ['/case.html?id=8', '/case.html?id=9']);
    const links = document.querySelectorAll('.topnav .links a').map(node => node.getAttribute('href'));
    assert(links.includes('/cases.html') && links.includes('/profile.html'));
    for (const closed of ['/fees.html', '/contacts.html', '/stats.html', '/share-repairs.html']) assert(!links.includes(closed));
    const hamburger = document.querySelector('.hamburger');
    await hamburger.emit('click');
    assert.equal(hamburger.getAttribute('aria-expanded'), 'true');
    await document.emit('keydown', { key: 'Escape' });
    assert.equal(hamburger.getAttribute('aria-expanded'), 'false');
    await document.querySelector('.sk[data-skin-value="paper"]').emit('click');
    assert.equal(document.documentElement.getAttribute('data-skin'), 'paper');
    const form = id('new-case-form');
    if (role !== 'viewer') {
      form.elements.name.value = '合成新案件';
      await form.emit('submit', { submitter: form.querySelector('button[type="submit"]') });
      assert.equal(JSON.parse(requests.at(-1).body).name, '合成新案件');
      assert.equal(location.href, '/case.html?id=10');
    } else assert(!form.listeners.has('submit'));
    assert(document.querySelector('.topnav [aria-label="退出登录"]'));
    const profile = await page('profile.html', 'profile', role);
    assert.deepEqual(paths(profile), ['/auth/me']);
    assert.match(text(id('account-name')), /合成账号/);
    assert.equal(id('accounts-link').getAttribute('href'), '/users.html');
    await document.querySelector('.topnav [aria-label="退出登录"]').emit('click');
    assert.equal(location.href, '/login.html');
    assert.deepEqual(paths(profile), ['/auth/me', '/logout']);
    const accounts = await page('users.html', 'users', role);
    assert.deepEqual(paths(accounts), role === 'admin' ? ['/auth/me', '/users'] : ['/auth/me']);
    assert.equal(id('admin').hidden, role !== 'admin');
  }
}

if (scope === 'all' || scope === 'w2') {
  for (const role of ['admin', 'editor', 'viewer']) {
    const requests = await page('case.html', 'case', role, '?id=8', entry =>
      entry.method === 'PATCH' && entry.route === '/cases/8'
        ? { status: 409, body: { error: '记录已更新', code: 'version_conflict' } } : null);
    assert.deepEqual(new Set(paths(requests)), new Set(['/auth/me', '/case-options', '/cases/8',
      '/cases/8/facts', '/cases/8/fees', '/cases/8/files']));
    for (const element of document.querySelectorAll('[data-case-write]')) assert.equal(element.hidden, role === 'viewer');
    assert.equal(id('case-changes').hidden, role !== 'admin');
    assert.match(text(id('timeline')), /合成开庭.*合成日志|合成日志.*合成开庭/s);
    assert.match(text(id('case-runway')), /合成期限/);
    assert.match(text(id('open-tasks')), /合成待办/);
    assert.match(text(id('contact-list')), /合成联系人/);
    assert.match(text(id('fact-list')), /合成事实/);
    assert.match(text(id('fee-list')), /15\.33.*90\.00/);
    assert.match(text(id('case-archive-body')), /2\.01.*原金额未记录.*0\.00/s);
    assert(id('file-list').querySelectorAll('[download]').every(node => node.getAttribute('href').startsWith('/api/cases/8/file?')));
    assert.equal(id('file-list').querySelectorAll('[download]').length, 1);
    const edit = id('edit-form');
    if (role !== 'viewer') {
      edit.elements.name.value = '合成冲突草稿';
      await edit.emit('submit', { submitter: edit.querySelector('button[type="submit"]') });
      assert.deepEqual(JSON.parse(requests.at(-1).body), { name: '合成冲突草稿', version: 7 });
      assert.equal(edit.elements.name.value, '合成冲突草稿');
      assert(id('fact-add').listeners.has('click'));
      assert(id('up-btn').listeners.has('click'));
    } else {
      assert(!edit.listeners.has('submit') && !id('fact-add').listeners.has('click') && !id('up-btn').listeners.has('click'));
      assert(!document.querySelector('.stepper button'));
    }
    if (role === 'admin') {
      const fold = id('case-changes-fold');
      fold.open = true;
      await fold.emit('toggle');
      await flush();
      const last = id('case-changes-body').querySelector('button');
      await Promise.all([last.emit('click'), last.emit('click')]);
      assert.equal(paths(requests).filter(route => route === '/cases/8/audit').length, 2);
      assert.equal(text(id('case-changes-body')).match(/derive-deadline/g).length, 1);
      assert.match(text(id('case-changes-body')), /derive-task/);
      assert.equal(last.hidden, true);
    }
  }
}

if (scope === 'all' || scope === 'w3') {
  for (const role of ['admin', 'editor', 'viewer']) {
    const today = await page('index.html', 'today', role);
    assert.deepEqual(paths(today), ['/auth/me', '/case-dashboard/today']);
    assert.match(text(id('sec-lead')), /合成期限/);
    assert.match(text(id('sec-tasks')), /合成待办/);
    assert.match(text(id('sec-weektasks')), /本周无新增待办/);
    await id('sec-tasks').querySelector('button').emit('click');
    assert.match(text(document.querySelector('[role="dialog"]')), /合成待办/);
    assert(!document.querySelector('[role="dialog"] input'));
    assert.equal(today.length, 2);

    const calendar = await page('calendar.html', 'calendar', role);
    assert.deepEqual(paths(calendar), ['/auth/me', '/case-dashboard/calendar']);
    assert.match(text(id('grid')), /合成期限/);
    assert.match(text(id('unplanned-list')), /合成未排期/);
    assert(![...document.querySelectorAll('#grid [draggable]')].some(node => node.getAttribute('draggable') === 'true'));
    await id('unplanned-list').querySelector('button').emit('click');
    assert(document.querySelector('[role="dialog"]'));
    await id('next').emit('click');
    await flush();
    assert.match(text(id('cal-load')), /本月无排期/);
    await id('prev').emit('click');
    await flush();
    assert.match(text(id('grid')), /合成期限/);
    assert.equal(calendar[1].query, calendar.at(-1).query);
    assert(calendar.every(call => call.method === 'GET'));
  }
}

console.log('Phase2 original UI synthetic DOM passed: ' + scope);
