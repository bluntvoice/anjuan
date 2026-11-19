import assert from 'node:assert/strict';

// A minimal DOM fixture exercises the workspace module without starting a GUI.
class Element {
  constructor(tag, value = '') {
    this.nodeType = tag === '#text' ? 3 : 1;
    this.tagName = tag;
    this.textContent = value;
    this.value = '';
    this.children = [];
    this.attributes = {};
    this.listeners = {};
  }
  append(...children) {
    for (const child of children) child.parent = this;
    this.children.push(...children);
  }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  get lastElementChild() { return this.children.filter(node => node.nodeType === 1).at(-1); }
}

const labels = node => [node.textContent, ...node.children.map(labels)].filter(Boolean).join(' ');
const elements = function* (node) {
  yield node;
  for (const child of node.children) yield* elements(child);
};
const caseRow = { id: 8, name: '合成案卷', stage: '待受理', status: 'active', version: 1 };
const fixture = {
  '/case-options': { case_types: ['民事'], procedures: { 一审: ['待受理'] }, criminal_fields: [], contact_roles: ['其他'] },
  '/cases': [caseRow],
  '/cases/8': { case: caseRow, condition_warnings: [], events: [], deadlines: [], tasks: [], worklog: [],
    contacts: [{ id: 1, name: '合成联系人', role: '其他', version: 1 }],
    attachments: [{ id: 1, filename: '材料.txt', rel_path: '证据整理/材料.txt' }] },
  '/cases/8/fees': { totals: { unpaid_fen: '1533', paid_fen: '0', legacy_count: 3 }, items: [
    { id: 1, agreed_amount: '17.03', payable_percent: '90.00', payable_amount: '15.33', status: 'unpaid' },
    { id: 2, recorded_amount: '2.01', legacy: true, status: 'paid' },
    { id: 3, recorded_amount: null, legacy: true, status: 'unpaid' },
    { id: 4, recorded_amount: '0.00', legacy: true, status: 'unpaid' },
  ] },
  '/cases/8/facts': [{ id: 1, content: '合成事实', version: 1 }],
  '/cases/8/files': { exists: true, dirs: [], files: [],
    write_dirs: ['证据整理'] },
};

for (const role_key of ['viewer', 'editor', 'admin']) {
  const ids = ['case-detail', 'record-dialog', 'message', 'case-list', 'case-query', 'search', 'new-case', 'logout', 'identity'];
  const nodes = Object.fromEntries(ids.map(id => [id, new Element('test')]));
  globalThis.window = new Element('window');
  globalThis.document = {
    getElementById: id => nodes[id],
    createElement: tag => new Element(tag),
    createTextNode: value => new Element('#text', String(value)),
  };
  const fetched = [];
  globalThis.fetch = async destination => {
    const url = new URL(destination, 'http://127.0.0.1:18000');
    assert.equal(url.origin, 'http://127.0.0.1:18000');
    const route = url.pathname.slice(4);
    fetched.push(route);
    let body = route === '/auth/me' ? { user: { role_key, display_name: '合成账号' } } : fixture[route];
    if (route === '/cases/8/audit') {
      const before = url.searchParams.get('before');
      body = {
        items: [{ at: '合成时间', action: before ? 'derive-task' : 'derive-deadline', entity: 'task', entity_id: 27, actor: '合成角色' }],
        next_before: before ? null : 42,
      };
    }
    assert(body, 'Unexpected route ' + route);
    return new Response(JSON.stringify(body), { status: 200 });
  };

  await import('../../public/js/phase2.js?role=' + role_key);
  assert.equal(nodes['new-case'].hidden, role_key === 'viewer');
  assert.match(nodes.identity.textContent, /合成账号/);
  await nodes['case-list'].children[0].listeners.click();
  assert.match(labels(nodes['case-detail']), /合成联系人/);
  assert.match(labels(nodes['case-detail']), /合成事实/);
  assert.match(labels(nodes['case-detail']), /15\.33/);
  assert.match(labels(nodes['case-detail']), /未记录/);
  const testcase = [...elements(nodes['case-detail'])];
  const buttons = testcase.filter(element => element.tagName === 'button').map(labels);
  assert.equal(buttons.includes('编辑案件'), role_key !== 'viewer');
  assert.equal(buttons.includes('添加律师费'), role_key !== 'viewer');
  assert.equal(buttons.includes('上传文件'), role_key !== 'viewer');
  assert.equal(buttons.includes('查看审计'), role_key === 'admin');
  const recordedAmounts = testcase.filter(node => node.tagName === 'div' && node.children[0]?.tagName === 'dt' &&
    labels(node.children[0]) === '原记录金额').map(node => labels(node.children[1]));
  assert.deepEqual(recordedAmounts, ['2.01', '—', '0.00']);
  const download = testcase.find(node => node.attributes.download);
  assert.match(download.attributes.href, /^\/api\/cases\/8\/file\?path=/);
  assert.deepEqual(new Set(fetched), new Set(['/auth/me', '/case-options', '/cases', '/cases/8',
    '/cases/8/facts', '/cases/8/fees', '/cases/8/files']));
  if (role_key === 'admin') {
    const first = testcase.find(node => node.tagName === 'button' && labels(node) === '查看审计');
    await first.listeners.click({ currentTarget: first });
    const more = [...elements(nodes['case-detail'])].find(node => node.tagName === 'button' && labels(node) === '加载更早记录');
    await Promise.all([more.listeners.click({ currentTarget: more }), more.listeners.click({ currentTarget: more })]);
    assert.equal(fetched.filter(route => route === '/cases/8/audit').length, 2, 'one request per audit page');
    assert.equal(labels(nodes['case-detail']).match(/derive-task/g)?.length, 1);
    assert(!labels(nodes['case-detail']).includes('加载更早记录'));
  }
}

console.log('PHASE2_RENDERER synthetic DOM: all three roles, file links, fee display and allowed fetches passed');
