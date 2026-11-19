import { api, el, SEV_LABEL, STATUS_LABEL } from './api.js';

const byId = id => document.getElementById(id);
const detail = byId('case-detail');
const dialog = byId('record-dialog');
const statuses = { active: '在办', shelved: '搁置', closed: '已结案' };
const payments = { unpaid: '未付款', paid: '已付款', waived: '历史免除' };
const roles = { admin: '管理员', editor: '编辑人员', viewer: '只读人员' };
const precondition = { unknown: '未确认', yes: '是', no: '否' };
const money = value => {
  const fen = BigInt(value);
  return '¥' + (fen / 100n).toString() + '.' + (fen % 100n).toString().padStart(2, '0');
};

let user, options, cases = [], currentId = null;
let detailRequest = 0;
let listRequest = 0;
const mayWrite = () => ['admin', 'editor'].includes(user?.role_key);
const casePath = id => '/cases/' + id;

function message(text = '') { byId('message').textContent = text; }

function button(label, onclick) {
  return el('button', { type: 'button', class: 'btn', onclick }, label);
}

function text(value, fallback = '—') { return value ? String(value) : fallback; }

function fieldsBox(values) {
  return el('dl', { class: 'workspace-fields' }, values.map(([label, value]) =>
    el('div', {}, el('dt', {}, label), el('dd', {}, text(value)))));
}

function heading(title, action) {
  return el('div', { class: 'workspace-heading' }, el('h3', {}, title), action);
}

function section(title, action, ...contents) {
  return el('section', { class: 'workspace-section' }, heading(title, action), ...contents);
}

function rowsOrEmpty(rows, empty = '暂无记录') {
  return rows.length ? rows : el('p', { class: 'workspace-muted' }, empty);
}

function updateCaseList() {
  byId('case-list').replaceChildren(...[rowsOrEmpty(cases.map(c => el('button', {
    class: 'workspace-case', type: 'button', 'aria-current': c.id === currentId ? 'true' : 'false',
    onclick: () => selectCase(c.id),
  }, el('strong', {}, c.name), el('span', { class: 'workspace-muted' },
  [c.case_no, statuses[c.status], c.stage].filter(Boolean).join(' · ')))), '未找到案件')].flat());
}

async function refreshCases() {
  const sequence = ++listRequest;
  const query = byId('case-query').value.trim();
  const result = await api('/cases' + (query ? '?' + new URLSearchParams({ q: query }) : ''));
  if (sequence !== listRequest) return;
  cases = result;
  updateCaseList();
}

function keyValues(c) {
  return [
    ['案号', c.case_no], ['案件类型', c.case_type], ['案由', c.cause], ['法院 / 机构', c.court],
    ['委托人', c.client], ['委托人地位', c.client_role], ['对方当事人', c.opponent],
    ['程序', c.procedure], ['阶段', c.stage], ['状态', statuses[c.status]], ['受理日', c.accepted_at],
    ['诉讼时效起算日', c.sol_starts_on], ['复议前置', precondition[c.reconsideration_precondition]],
    ...options.criminal_fields.filter(field => c[field.key]).map(field => [field.label, c[field.key]]), ['备注', c.note],
  ];
}

async function selectCase(id, relative = '') {
  currentId = id;
  updateCaseList();
  message();
  const sequence = ++detailRequest;
  detail.replaceChildren(el('p', {}, '正在读取案件…'));
  const root = casePath(id);
  try {
    const [result, facts, fees] = await Promise.all([api(root), api(root + '/facts'), api(root + '/fees')]);
    if (sequence !== detailRequest) return;
    const c = result.case;
    const contactAction = mayWrite() ? button('添加联系人', () => contactForm(id)) : null;
    const factAction = mayWrite() ? button('添加事实', () => factForm(id)) : null;
    const feeAction = mayWrite() ? button('添加律师费', () => feeForm(id)) : null;
    const files = section('案件文件', null, el('div', {}));
    const audit = user.role_key === 'admin' ? auditSection(id) : null;
    const warnings = result.condition_warnings;
    detail.replaceChildren(...[
      el('header', { class: 'workspace-heading' }, el('h2', {}, c.name),
        mayWrite() ? button('编辑案件', () => caseForm(c)) : null),
      fieldsBox(keyValues(c)),
      section('程序进度', null,
        ...(Array.isArray(warnings) && warnings.length ? [el('p', {}, '期限计算条件待补充')] : []),
        progressGroup('程序事件', result.events, row => [row.occurred_on, row.type, row.note].filter(Boolean).join(' · ')),
        progressGroup('期限', result.deadlines, row => [row.due_on, row.name, SEV_LABEL[row.severity], STATUS_LABEL[row.status]].filter(Boolean).join(' · ')),
        progressGroup('待办', result.tasks, row => [row.title, { open: '未完成', done: '已完成', dropped: '已取消' }[row.status]].filter(Boolean).join(' · ')),
        progressGroup('工作日志', result.worklog, row => [row.worked_on, row.content].filter(Boolean).join(' · '))),
      section('联系人', contactAction, rowsOrEmpty(result.contacts.map(row => simpleRow(row.name,
        [row.role, row.org, row.phone, row.id_no, row.note], () => contactForm(id, row))))),
      section('事实记录', factAction, rowsOrEmpty(facts.map(row => simpleRow(text(row.occurred_on, '日期未记录'),
        [row.content, row.source, row.note], () => factForm(id, row))))),
      section('律师费', feeAction, el('p', {}, '未付款 ' + money(fees.totals.unpaid_fen) + '　已付款 ' + money(fees.totals.paid_fen) +
        (fees.totals.legacy_count ? '　历史记录 ' + fees.totals.legacy_count + ' 笔，单列展示' : '')),
        rowsOrEmpty(fees.items.map(row => feeRow(id, row)))),
      files,
      section('附件引用', null, rowsOrEmpty(result.attachments.map(row => el('div', { class: 'workspace-row' },
        fileLink(id, row.rel_path, row.filename), row.entity ? el('p', {}, referenceLabel(row)) : null)))),
      audit,
    ].filter(Boolean));
    await renderFiles(files.lastElementChild, id, relative);
  } catch (error) {
    if (sequence === detailRequest) {
      message(error.message);
      detail.replaceChildren(el('p', {}, '案件读取失败。'), button('重试', () => selectCase(id)));
    }
  }
}

function progressGroup(title, rows, format) {
  return el('details', {},
    el('summary', {}, title + '（' + rows.length + '）'),
    rowsOrEmpty(rows.map(row => el('div', { class: 'workspace-row' }, format(row)))));
}

function simpleRow(title, parts, edit) {
  return el('div', { class: 'workspace-row' },
    el('div', { class: 'workspace-heading' }, el('strong', {}, title), mayWrite() && edit ? button('编辑', edit) : null),
    ...parts.filter(Boolean).map(part => el('p', {}, part)));
}

function feeRow(id, row) {
  const detail = row.legacy
    ? [['原记录金额', row.recorded_amount], ['应付比例', '未记录']]
    : [['约定金额', row.agreed_amount], ['应付比例', row.payable_percent + '%'], ['折后金额', row.payable_amount]];
  return el('div', { class: 'workspace-row' },
    el('div', { class: 'workspace-heading' }, el('strong', {}, row.legacy ? '历史记录' : '律师费'),
      mayWrite() && !row.legacy ? button('编辑', () => feeForm(id, row)) : null),
    fieldsBox([...detail, ['付款状态', payments[row.status] ?? row.status], ['备注', row.note]]));
}

function referenceLabel(row) {
  return ({ event: '事件', deadline: '期限', fee: '律师费', worklog: '工作日志' }[row.entity] || '记录') + ' #' + row.entity_id;
}

function fileLink(id, relative, filename) {
  const href = '/api' + casePath(id) + '/file?' + new URLSearchParams({ path: relative });
  const download = el('a', { download: filename, href }, filename);
  if (!/\.(pdf|png|jpe?g|gif|webp|txt|md)$/iu.test(filename)) return download;
  return el('span', { class: 'workspace-actions' }, download,
    el('a', { href, target: '_blank', rel: 'noopener' }, '预览'));
}

async function renderFiles(container, id, relative = '') {
  container.replaceChildren(el('p', {}, '正在读取目录…'));
  try {
    const root = casePath(id);
    const result = await api(root + '/files?' + new URLSearchParams({ dir: relative }));
    if (!result.exists) {
      container.replaceChildren(el('p', {}, '案件文件夹不存在。'));
      return;
    }
    const parent = relative.split('/').slice(0, -1).join('/');
    const upload = mayWrite() ? button('上传文件', () => uploadForm(id, result.write_dirs, relative)) : null;
    const directories = result.dirs.map(name => el('div', { class: 'workspace-row' },
      button(name + ' /', () => renderFiles(container, id, [relative, name].filter(Boolean).join('/')))));
    const files = result.files.map(file => {
      const path = [relative, file.name].filter(Boolean).join('/');
      return el('div', { class: 'workspace-row workspace-heading' }, fileLink(id, path, file.name),
        el('span', { class: 'workspace-muted' }, file.mtime + ' · ' + file.size + ' B'),
        mayWrite() ? button('添加到附件引用', () => attachForm(id, path)) : null);
    });
    container.replaceChildren(el('div', { class: 'workspace-heading' }, el('strong', {}, relative || '案件文件夹'),
      el('div', { class: 'workspace-actions' }, relative ? button('上一级', () => renderFiles(container, id, parent)) : null, upload)),
      ...(result.workspace_notice ? [el('p', {}, result.workspace_notice)] : []),
      ...[rowsOrEmpty([...directories, ...files], '此目录为空')].flat());
  } catch (error) {
    container.replaceChildren(el('p', {}, error.message), button('重试', () => renderFiles(container, id, relative)));
  }
}

function auditSection(id) {
  const output = el('div', {});
  const auditRow = entry => el('div', { class: 'workspace-row' },
    [entry.at, entry.action, entry.entity + ' #' + entry.entity_id, '操作人 ' + entry.actor].join(' · '));
  async function load(trigger, before = null) {
    if (trigger.disabled) return;
    trigger.disabled = true;
    try {
      const data = await api(casePath(id) + '/audit' + (before ? '?before=' + before : ''));
      const items = data.items.map(auditRow);
      if (before) trigger.remove();
      output.append(...[rowsOrEmpty(items)].flat());
      if (data.next_before) {
        output.append(button('加载更早记录', event => load(event.currentTarget, data.next_before)));
      }
    } catch (error) {
      trigger.disabled = false;
      message(error.message);
    }
  }
  const action = button('查看审计', event => load(event.currentTarget));
  return section('案件审计', action, output);
}

function selectInput(key, values, initial) {
  const select = el('select', { name: key }, values.map(choice => {
    const [value, label] = Array.isArray(choice) ? choice : [choice, choice];
    return el('option', { value }, label || '未填写');
  }));
  select.value = initial;
  return select;
}

function formDialog(title, controls, save) {
  if (!mayWrite()) return;
  const errorBox = el('p', { class: 'wide workspace-message', role: 'alert' });
  const submit = el('button', { type: 'submit', class: 'btn primary' }, '保存');
  const cancel = button('取消', () => dialog.close());
  const form = el('form', { class: 'workspace-form' }, controls, errorBox,
    el('div', { class: 'wide workspace-actions' }, cancel, submit));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const formData = new FormData(form);
    submit.disabled = true;
    cancel.disabled = true;
    errorBox.textContent = '';
    try {
      const afterSave = await save(Object.fromEntries(formData), errorBox, form);
      if (afterSave === false) return;
      dialog.close();
      await afterSave?.();
    } catch (error) {
      if (dialog.open) errorBox.textContent = error.message;
      else message(error.message);
    } finally {
      submit.disabled = false;
      cancel.disabled = false;
    }
  });
  dialog.oncancel = event => { if (submit.disabled) event.preventDefault(); };
  dialog.replaceChildren(el('h2', { id: 'dialog-title' }, title), form);
  dialog.showModal();
}

function control(label, widget, wide = false) {
  return el('label', { class: wide ? 'wide' : '' }, label, widget);
}

function input(key, label, value, extra = {}) {
  return control(label, el('input', { name: key, value: value ?? '', ...extra }));
}

function note(key, label, value, required = false) {
  return control(label, el('textarea', { name: key, rows: 3, required: required ? '' : null }, value ?? ''), true);
}

function caseForm(c = null) {
  const initial = c ?? {};
  const type = selectInput('case_type', options.case_types, initial.case_type ?? '未分类');
  const procedure = selectInput('procedure', Object.keys(options.procedures), initial.procedure ?? '一审');
  const stage = selectInput('stage', [], '');
  function fillStage(value) {
    const names = options.procedures[procedure.value] ?? [];
    const display = value !== undefined && !names.includes(value) ? [value, ...names] : names;
    stage.replaceChildren(...display.map(name => el('option', { value: name }, name || '未填写')));
    stage.value = value ?? names[0] ?? '';
  }
  fillStage(initial.stage);
  procedure.addEventListener('change', () => fillStage());
  const controls = [input('name', '案件名称', initial.name, { required: '', maxlength: 500 }),
    input('case_no', '案号', initial.case_no), control('案件类型', type), control('程序', procedure), control('阶段', stage),
    input('cause', '案由', initial.cause), input('court', '法院 / 机构', initial.court), input('client', '委托人', initial.client),
    input('client_role', '委托人地位', initial.client_role), input('opponent', '对方当事人', initial.opponent),
    input('accepted_at', '受理日', initial.accepted_at, { type: 'date' }),
    input('sol_starts_on', '诉讼时效起算日', initial.sol_starts_on, { type: 'date' }),
    control('复议前置', selectInput('reconsideration_precondition', Object.entries(precondition), initial.reconsideration_precondition ?? 'unknown'))];
  if (c) controls.push(control('状态', selectInput('status', Object.entries(statuses), c.status)));
  else controls.push(input('folder_path', '案件夹名称（默认与案名相同）', ''));
  controls.push(el('details', { class: 'wide' }, el('summary', {}, '刑事案件字段'), el('div', { class: 'workspace-form' },
    options.criminal_fields.map(({ key, label, options: values }) => values
      ? control(label, selectInput(key, ['', ...values], initial[key] ?? ''))
      : input(key, label, initial[key], { maxlength: 1000 })))));
  controls.push(note('note', '备注', initial.note));
  let confirmedInput = null;
  formDialog(c ? '编辑案件' : '新建案件', controls, async (body, feedback, form) => {
    if (c) {
      for (const key of Object.keys(body)) if (body[key] === c[key]) delete body[key];
      if (!Object.keys(body).length) { feedback.textContent = '没有修改。'; return false; }
      if (body.procedure && !body.stage) body.stage = form.elements.stage.value;
    } else if (!body.folder_path) delete body.folder_path;
    const confirmationKey = JSON.stringify(body);
    if (c) {
      body.version = c.version;
      if (confirmedInput === confirmationKey) body.confirm_rederive = true;
    }
    const saved = await api(c ? casePath(c.id) : '/cases', { method: c ? 'PATCH' : 'POST', body });
    if (saved.needs_confirm) {
      confirmedInput = confirmationKey;
      const { retire, protected: protectedRows } = saved.condition_preview;
      feedback.textContent = '本次变更将停用 ' + retire.length + ' 项派生期限，保留 ' + protectedRows.length + ' 项受保护期限。核对后再次保存确认。';
      return false;
    }
    return async () => { await refreshCases(); await selectCase(saved.id); };
  });
}

async function saveRecord(caseId, type, row, payload) {
  if (row) payload.version = row.version;
  const suffix = '/' + type + (row ? '/' + row.id : '');
  await api(casePath(caseId) + suffix, { method: row ? 'PATCH' : 'POST', body: payload });
  return async () => { if (currentId === caseId) await selectCase(caseId); };
}

function contactForm(id, row = null) {
  const c = row ?? {};
  formDialog(row ? '编辑联系人' : '添加联系人', [
    input('name', '姓名', c.name, { required: '' }),
    control('角色', selectInput('role', options.contact_roles, c.role ?? options.contact_roles[0])),
    input('phone', '电话', c.phone, { type: 'tel' }), input('id_no', '证件号', c.id_no),
    input('org', '单位', c.org), note('note', '备注', c.note),
  ], body => saveRecord(id, 'contacts', row, body));
}

function factForm(id, row = null) {
  const f = row ?? {};
  formDialog(row ? '编辑事实' : '添加事实', [
    input('occurred_on', '发生日期', f.occurred_on, { type: 'date' }), input('source', '来源', f.source),
    note('content', '事实内容', f.content, true), note('note', '备注', f.note),
  ], body => saveRecord(id, 'facts', row, body));
}

function feeForm(id, row = null) {
  const fee = row ?? {};
  formDialog(row ? '编辑律师费' : '添加律师费', [
    input('agreed_amount', '约定金额（元）', fee.agreed_amount, { required: '', inputmode: 'decimal' }),
    input('payable_percent', '应付比例（%）', fee.payable_percent ?? '100', { required: '', inputmode: 'decimal' }),
    control('付款状态', selectInput('status', [['unpaid', '未付款'], ['paid', '已付款']], fee.status ?? 'unpaid')),
    note('note', '备注', fee.note),
  ], body => saveRecord(id, 'fees', row, body));
}

function attachForm(id, path) {
  formDialog('添加附件引用', [el('p', { class: 'wide' }, path)], async () => {
    await api(casePath(id) + '/attachments', { method: 'POST', body: { rel_path: path } });
    return async () => { if (currentId === id) await selectCase(id); };
  });
}

function uploadForm(id, directories, relative) {
  formDialog('上传案件文件', [
    input('file', '选择文件', undefined, { type: 'file', required: '' }),
    control('归档目录', selectInput('dir', directories, directories.includes(relative) ? relative : directories[0])),
  ], async ({ file, dir }) => {
    const query = new URLSearchParams({ dir, name: file.name });
    const response = await fetch('/api' + casePath(id) + '/files?' + query, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
    });
    if (response.status === 401) { location.href = '/login.html'; return false; }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '文件上传失败');
    return async () => {
      if (currentId !== id) return;
      await selectCase(id, dir);
    };
  });
}

window.addEventListener('pageshow', event => {
  if (event.persisted) location.reload();
});
byId('search').addEventListener('submit', event => {
  event.preventDefault();
  refreshCases().catch(error => message(error.message));
});
byId('new-case').addEventListener('click', () => caseForm());
byId('logout').addEventListener('click', async () => {
  try { await api('/logout', { method: 'POST' }); location.href = '/login.html'; }
  catch (error) { message(error.message); }
});

try {
  [{ user }, options] = await Promise.all([api('/auth/me'), api('/case-options')]);
  byId('identity').textContent = user.display_name + ' · ' + roles[user.role_key];
  byId('new-case').hidden = !mayWrite();
  await refreshCases();
} catch (error) {
  message(error.message);
}
