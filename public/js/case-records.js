import { api, el, toast } from './api.js';
import { datePrompt } from './dateedit.js';
import { confirmModal } from './modal.js';

const paymentLabel = { unpaid: '未付款', paid: '已付款', waived: '历史免除' };
const field = (key, label, value, type = 'text', extras = {}) => ({ key, label, value, type, ...extras });

function yuan(fen) {
  const amount = BigInt(fen);
  return '¥' + (amount / 100n) + '.' + String(amount % 100n).padStart(2, '0');
}

export function mountCaseRecords({ id, canWrite, canAudit, options, reloadCase }) {
  const byId = value => document.getElementById(value);
  const path = '/cases/' + id;
  const write = (kind, row, fields) => api(path + '/' + kind + (row ? '/' + row.id : ''), {
    method: row ? 'PATCH' : 'POST',
    body: row ? { ...fields, version: row.version } : fields,
  });
  const empty = text => el('div', { class: 'section-empty' }, text);
  const edit = (label, onclick) => el('button', { class: 'btn small', type: 'button', onclick }, label);

  function fileLinks(relative, { label = relative, previewClass = '' } = {}) {
    const href = '/api' + path + '/file?' + new URLSearchParams({ path: relative });
    return [
      el('a', { class: previewClass, href, target: '_blank', rel: 'noopener' }, label),
      el('a', { class: 'btn small', href, download: '', 'aria-label': '下载 ' + label }, '下载'),
    ];
  }

  async function editContact(row) {
    const roles = [...new Set([row.role, ...options.contact_roles].filter(Boolean))];
    const result = await datePrompt({
      title: '编辑联系人',
      fields: [
        field('name', '姓名', row.name, 'text', { required: true }),
        field('role', '角色', row.role, 'select', { options: roles.map(value => ({ value, label: value })) }),
        field('phone', '电话', row.phone, 'tel'), field('id_no', '证件号', row.id_no),
        field('org', '单位', row.org), field('note', '备注', row.note),
      ],
      save: fields => write('contacts', row, fields),
    });
    if (result) await reloadCase().catch(() => {});
  }

  async function loadFacts() {
    const rows = await api(path + '/facts');
    byId('fact-list').replaceChildren(...(rows.length ? rows.map(row =>
      el('div', { class: 'row' },
        el('div', { class: 'grow' },
          el('p', {}, row.content),
          el('p', { class: 'meta' }, [row.occurred_on, row.source, row.note].filter(Boolean).join(' · '))
        ),
        canWrite ? edit('编辑事实', () => editFact(row)) : null
      )) : [empty('暂无事实记录')]));
  }

  async function editFact(row = null) {
    const result = await datePrompt({
      title: row ? '编辑事实' : '添加事实',
      fields: [
        field('content', '事实内容', row?.content, 'textarea', { required: true }),
        field('occurred_on', '发生日期', row?.occurred_on, 'date'),
        field('source', '来源', row?.source), field('note', '备注', row?.note, 'textarea'),
      ],
      save: fields => write('facts', row, fields),
    });
    if (result) await loadFacts().catch(() => {});
  }

  async function loadFees() {
    const { items, totals } = await api(path + '/fees');
    const current = items.filter(item => !item.legacy);
    const history = items.filter(item => item.legacy);
    byId('case-money-badge').textContent = items.length || '';
    byId('fee-viz').textContent = '未付款 ' + yuan(totals.unpaid_fen) + ' · 已付款 ' + yuan(totals.paid_fen);
    byId('fee-list').replaceChildren(...(current.length ? current.map(row =>
      el('div', { class: 'row' },
        el('div', { class: 'grow' },
          el('b', {}, '应付 ¥' + row.payable_amount),
          el('p', { class: 'meta' }, '约定 ¥' + row.agreed_amount + ' · 应付比例 ' + row.payable_percent + '%'),
          row.note ? el('p', {}, row.note) : null
        ),
        el('span', { class: 'pill' }, paymentLabel[row.status] || row.status),
        canWrite ? edit('编辑律师费', () => editFee(row)) : null
      )) : [empty('暂无律师费')]));
    byId('case-archive').hidden = !history.length;
    document.querySelector('[data-target="case-archive"]').hidden = !history.length;
    byId('case-archive-count').textContent = history.length + ' 项';
    byId('case-archive-body').replaceChildren(...history.map(row =>
      el('div', { class: 'archive-door-row' },
        el('span', { class: 'archive-door-key' }, paymentLabel[row.status] || row.status),
        el('span', { class: 'archive-door-val' },
          (row.recorded_amount === null ? '原金额未记录' : '原金额 ¥' + row.recorded_amount) + ' · 应付比例未记录'),
        row.note ? el('span', { class: 'meta' }, row.note) : null
      )));
  }

  async function editFee(row = null) {
    const amount = { required: true, inputmode: 'decimal' };
    const result = await datePrompt({
      title: row ? '编辑律师费' : '记律师费',
      fields: [
        field('agreed_amount', '约定金额（元）', row?.agreed_amount, 'text', amount),
        field('payable_percent', '应付比例（%）', row?.payable_percent ?? '100', 'text', amount),
        field('status', '付款状态', row?.status ?? 'unpaid', 'select', {
          options: ['unpaid', 'paid'].map(value => ({ value, label: paymentLabel[value] })),
        }),
        field('note', '备注', row?.note, 'textarea'),
      ],
      save: fields => write('fees', row, fields),
    });
    if (result) await loadFees().catch(() => {});
  }

  async function attach(relative) {
    if (!await confirmModal('添加附件引用：' + relative, { title: '登记附件', confirmLabel: '登记' })) return;
    try {
      await write('attachments', null, { rel_path: relative });
      toast('附件已登记');
      await reloadCase();
    } catch { /* api() displays the failure. */ }
  }

  if (canWrite) {
    byId('contact-form').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = event.submitter;
      button.disabled = true;
      try {
        await write('contacts', null, Object.fromEntries(new FormData(form)));
        form.reset();
        await reloadCase();
      } catch { /* Keep the form draft if the write is rejected. */ }
      finally { button.disabled = false; }
    });
    byId('fact-add').addEventListener('click', () => editFact());
    byId('fee-add').addEventListener('click', () => editFee());
  }

  if (canAudit) {
    const audit = byId('case-changes-fold');
    const output = byId('case-changes-body');
    const list = el('div', {});
    const seen = new Set();
    let cursor = null;
    let loaded = false;
    const next = edit('加载更早记录', readAudit);
    const state = el('p', { class: 'meta', role: 'status' });
    output.replaceChildren(list, state, next);
    next.hidden = true;
    async function readAudit() {
      if (next.disabled) return;
      next.disabled = true;
      state.textContent = '正在读取…';
      try {
        const { items, next_before } = await api(path + '/audit' + (cursor ? '?before=' + cursor : ''));
        for (const row of items) {
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          list.append(el('div', { class: 'row' },
            el('time', {}, row.at),
            el('span', { class: 'grow' }, row.action + ' · ' + row.entity + ' #' + row.entity_id),
            el('span', { class: 'meta' }, '操作人 ' + row.actor)
          ));
        }
        loaded = true;
        next.hidden = !next_before;
        cursor = next_before;
        state.textContent = seen.size ? '' : '暂无审计记录';
      } catch {
        state.textContent = '读取失败';
        next.hidden = false;
      } finally {
        next.textContent = loaded ? '加载更早记录' : '重试';
        next.disabled = false;
      }
    }
    audit.addEventListener('toggle', () => { if (audit.open && !loaded) void readAudit(); });
    if (audit.open) void readAudit();
  }

  async function load() {
    await Promise.all([
      loadFacts().catch(() => byId('fact-list').replaceChildren(empty('读取事实失败'))),
      loadFees().catch(() => byId('fee-list').replaceChildren(empty('读取律师费失败'))),
    ]);
  }

  return { load, editContact, attach, fileLinks };
}
