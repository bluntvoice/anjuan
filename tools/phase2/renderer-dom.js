import { readFileSync } from 'node:fs';

const matches = (node, selector) => {
  const tag = selector.match(/^[a-z][\w-]*/i);
  if (tag && node.tagName !== tag[0].toUpperCase()) return false;
  const id = selector.match(/#([\w-]+)/);
  if (id && node.getAttribute('id') !== id[1]) return false;
  for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) {
    if (!node.classList.contains(name)) return false;
  }
  for (const [, name, value] of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
    if (!node.hasAttribute(name) || (value !== undefined && node.getAttribute(name) !== value)) return false;
  }
  return true;
};

function select(root, list) {
  return [...descendants(root)].filter(node => node.nodeType === 1 && list.split(',').some(raw => {
    const parts = raw.trim().split(/\s+(?![^[]*\])/);
    if (!matches(node, parts.pop())) return false;
    let parent = node.parent;
    while (parts.length) {
      const ancestor = parts.pop();
      while (parent && !matches(parent, ancestor)) parent = parent.parent;
      if (!parent) return false;
      parent = parent.parent;
    }
    return true;
  }));
}

export function* descendants(node) {
  for (const child of node.children) {
    yield child;
    yield* descendants(child);
  }
}

export class Element {
  constructor(tag, data = '') {
    this.nodeType = tag === '#text' ? 3 : 1;
    this.tagName = tag.toUpperCase();
    this.data = data;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.style = {};
    this.classList = {
      contains: token => this.className.split(/\s+/u).includes(token),
      toggle: (token, flag = !this.classList.contains(token)) => {
        const names = new Set(this.className.split(/\s+/u).filter(Boolean));
        if (flag) names.add(token); else names.delete(token);
        this.className = [...names].join(' ');
        return flag;
      },
      add: (...tokens) => tokens.forEach(token => this.classList.toggle(token, true)),
      remove: (...tokens) => tokens.forEach(token => this.classList.toggle(token, false)),
    };
  }
  get className() { return this.getAttribute('class') || ''; }
  set className(value) { this.setAttribute('class', value); }
  get textContent() { return this.data + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this.data = String(value); }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(value) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  get open() { return this.hasAttribute('open'); }
  set open(value) { if (value) this.setAttribute('open', ''); else this.removeAttribute('open'); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(value) { if (value) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get options() { return this.querySelectorAll('option'); }
  get value() {
    if (this.currentValue !== undefined) return this.currentValue;
    if (this.tagName === 'SELECT') {
      const chosen = this.options.find(option => option.hasAttribute('selected')) || this.options[0];
      return chosen?.value || '';
    }
    return this.getAttribute('value') ?? (this.tagName === 'OPTION' ? this.textContent : '');
  }
  set value(value) { this.currentValue = String(value); }
  get elements() {
    return Object.fromEntries(this.querySelectorAll('input[name], select[name], textarea[name]')
      .map(node => [node.getAttribute('name'), node]));
  }
  get isConnected() { return Boolean(this.parent); }
  get lastElementChild() { return this.children.filter(node => node.nodeType === 1).at(-1); }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      this.dataset[key] = String(value);
    }
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  prepend(...children) { this.children.unshift(...children.map(value => this.adopt(value))); }
  append(...children) { this.children.push(...children.map(value => this.adopt(value))); }
  appendChild(child) { this.append(child); return child; }
  adopt(value) {
    const child = value instanceof Element ? value : new Element('#text', String(value));
    child.remove();
    child.parent = this;
    return child;
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.data = '';
    this.append(...children);
  }
  before(node) {
    const parent = this.parent;
    parent.children.splice(parent.children.indexOf(this), 0, parent.adopt(node));
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  querySelectorAll(selector) { return select(this, selector); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  matches(selector) { return selector.split(',').some(part => matches(this, part.trim())); }
  contains(node) { return this === node || [...descendants(this)].includes(node); }
  getClientRects() { return this.hidden ? [] : [1]; }
  focus() { document.activeElement = this; }
  scrollIntoView() {}
  reset() { for (const node of Object.values(this.elements)) delete node.currentValue; }
  addEventListener(name, listener) {
    const handlers = this.listeners.get(name) || new Set();
    handlers.add(listener);
    this.listeners.set(name, handlers);
  }
  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
  dispatchEvent(event) { void this.emit(event.type, event); }
  async emit(name, args = {}) {
    const event = { type: name, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...args };
    for (const handler of this.listeners.get(name) || []) await handler(event);
  }
}

const unpaired = new Set('meta link input br hr img area base col embed param source track wbr'.split(' '));

export function loadDocument(file) {
  // Only standard HTML elements and attributes used by the page fixtures are modeled here.
  const source = readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script>/gi, '');
  const doc = new Element('#document');
  const stack = [doc];
  const tokens = /<\/?([a-z][\w-]*)(?:"[^"]*"|'[^']*'|[^"'<>])*?>|[^<]+/gi;
  for (const token of source.matchAll(tokens)) {
    const [markup, tag] = token;
    if (!tag) {
      if (!markup.startsWith('!DOCTYPE') && markup.trim()) stack.at(-1).append(markup);
      continue;
    }
    if (markup.startsWith('</')) {
      if (stack.at(-1).tagName === tag.toUpperCase()) stack.pop();
      continue;
    }
    const item = new Element(tag);
    const fields = markup.slice(tag.length + 1, -1);
    for (const [, name, double, single, bare] of fields.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+)))?/g)) {
      item.setAttribute(name, double ?? single ?? bare ?? '');
    }
    stack.at(-1).append(item);
    if (!unpaired.has(tag) && !markup.endsWith('/>')) stack.push(item);
  }
  doc.documentElement = doc.querySelector('html');
  doc.body = doc.querySelector('body');
  doc.getElementById = id => doc.querySelector('#' + id);
  doc.createElement = tag => new Element(tag);
  doc.createElementNS = (_namespace, tag) => new Element(tag);
  doc.createTextNode = text => new Element('#text', String(text));
  return doc;
}
