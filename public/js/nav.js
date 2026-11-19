// 复用原顶栏结构，链接仅指向当前已开放的页面。
import { api, el } from './api.js';
import { iconEl } from './icons.js';
import { initSkinSwitcher } from './skin.js';

const LINKS = [
  ['/cases.html', '案件', 'cases'],
  ['/calendar.html', '日历', 'calendar'],
  ['/profile.html', '用户中心', 'user'],
];

export const ROLE_LABEL = { admin: '管理员', editor: '编辑人员', viewer: '只读人员' };
export const mayWriteCases = user => user.role_key === 'admin' || user.role_key === 'editor';

export async function logout() {
  await api('/logout', { method: 'POST' });
  location.replace('/login.html');
}

// 皮肤三键：专业(亮·默认) · 纸感(亮) · 翡翠(暗)。
// auto 不占键位——它由「未设置 data-skin」表达，切到 auto 走 profile 页的皮肤卡。
const SKIN_KEYS = [
  ['pro',   '专业', '专业：亮色扁平，等宽数字'],
  ['paper', '纸感', '纸感：暖白纸底，衬线排印'],
  ['jade',  '翡翠', '翡翠：暗色毛玻璃，衬线大数字'],
];

// 顶栏导航 = 纯文字（图标只留给移动端下拉：纵向菜单里图标才是有效的扫读辅助）
function navLink(href, label, path, ic) {
  return el('a', {
    href,
    class: href === path ? 'active' : '',
    'aria-current': href === path ? 'page' : undefined,
  }, ic ? iconEl(ic) : null, label);
}

export async function mountNav() {
  const { user } = await api('/auth/me');
  let path = location.pathname === '/index.html' ? '/' : location.pathname;
  if (path === '/case.html') path = '/cases.html';
  if (path === '/users.html') path = '/profile.html';

  const hamburger = el('button', { class: 'hamburger', 'aria-label': '菜单', 'aria-expanded': 'false' }, iconEl('menu'));
  const dropdown = el('div', { class: 'nav-dropdown' },
    LINKS.map(([href, label, ic]) => navLink(href, label, path, ic))
  );
  const nav = el('nav', { class: 'topnav' },
    hamburger,
    el('a', { class: 'brand', href: '/' },
      el('span', { class: 'seal', 'aria-hidden': 'true' }, '卷'),
      el('b', {}, '案卷')
    ),
    el('div', { class: 'links' },
      LINKS.map(([href, label]) => navLink(href, label, path))
    ),
    el('div', { class: 'spacer' }),
    el('div', { class: 'skins', role: 'group', 'aria-label': '主题皮肤切换' },
      SKIN_KEYS.map(([value, label, title]) => el('button', {
        class: 'sk',
        type: 'button',
        'data-skin-value': value,
        'aria-pressed': 'false',   // 真值由 skin.js 接管（auto 时点亮实际生效的那枚）
        title,
      }, label))
    ),
    el('span', { class: 'navbadge', id: 'nav-identity' }, `${user.display_name} · ${ROLE_LABEL[user.role_key]}`),
    el('button', {
      class: 'iconbtn', 'aria-label': '退出登录', title: '退出登录',
      onclick: async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try { await logout(); } catch { button.disabled = false; }
      },
    }, iconEl('logout')),
    dropdown
  );

  document.body.prepend(nav);
  initHamburger(hamburger, dropdown);
  initSkinSwitcher(nav);
  return user;
}

// 移动端汉堡菜单：展开/收起 + 外点关闭 + Escape 关闭 + 点链接自收
function initHamburger(hamburger, dropdown) {
  hamburger.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = dropdown.classList.toggle('open');
    hamburger.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target) && !hamburger.contains(e.target)) {
      dropdown.classList.remove('open');
      hamburger.setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      dropdown.classList.remove('open');
      hamburger.setAttribute('aria-expanded', 'false');
    }
  });
  dropdown.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => {
      dropdown.classList.remove('open');
      hamburger.setAttribute('aria-expanded', 'false');
    });
  });
}
