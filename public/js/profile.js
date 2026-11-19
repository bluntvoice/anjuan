// 皮肤契约（v2「一个骨架 · 三种材质」）：
//   · 卡片属性是 data-skin-value（旧名 data-theme-value 已废）→ dataset.skinValue
//   · 值域 pro | paper | jade | auto，与顶栏 .sk 三键共用 skin.js 一套状态机
//   · .selected / aria-pressed 由 skin.js 的 syncSwitchers() 全局维护——
//     mountNav() → initSkinSwitcher() → apply() 已扫过本页卡片，setSkin() 每次切换也重扫。
//     本文件只把「点击 / 键盘」翻译成 setSkin()，外加一次兜底同步（顶栏挂载失败时也不留错态）。
import { mountNav, ROLE_LABEL, logout } from './nav.js';
import { setSkin, getSkin, getResolvedSkin } from './skin.js';
const user = await mountNav();

// 账户与安全 / 关于：两条事实条，「展开/收起」就地展开同条内详情，不走 fold.js
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
bindStrip('profile-security-toggle', 'profile-security-more');
bindStrip('profile-about-toggle', 'profile-about-more');

const $ = (id) => document.getElementById(id);

/* ── 皮肤选择卡 ── */
const SKIN_LABEL = { pro: '专业 · 亮', paper: '纸感 · 亮', jade: '翡翠 · 暗' };
const cards = document.querySelectorAll('.theme-card');
const nowEl = $('skin-now');

/** p-foot 的「当前生效」：auto 时要把落地皮肤也说出来，否则用户看不出跟随到了哪边 */
function paintNow() {
  if (!nowEl) return;
  const pref = getSkin();
  const eff = SKIN_LABEL[getResolvedSkin()];
  nowEl.textContent = pref === 'auto' ? `跟随系统 → ${eff}` : eff;
}

function choose(c) {
  setSkin(c.dataset.skinValue);   // 写盘 + 落 DOM + 同步全站切换器（含本页卡片）
}

cards.forEach((c) => {
  c.addEventListener('click', () => choose(c));
  c.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(c); }
  });
});

// 初始选中态兜底（正常路径下 skin.js 已经设过一遍，这里是幂等重放）
const cur = getSkin();
cards.forEach((c) => {
  const on = c.dataset.skinValue === cur;
  c.classList.toggle('selected', on);
  c.setAttribute('aria-pressed', String(on));
});
paintNow();

// 「当前生效」要跟上**每一条**换肤路径，不只本页卡片——两个触发器缺一不可：
//  ① data-skin 变了：本页卡片、顶栏 .sk 三键、跨标签页 storage 同步都会走到这。
//     （auto 表达为「移除属性」，removeAttribute 同样产生 mutation record。）
//  ② auto 状态下 OS 翻转配色：属性一直是「不存在」，压根没有 mutation，
//     真正换肤的是 CSS 媒体查询——只能靠 matchMedia 兜这一路。
new MutationObserver(paintNow).observe(document.documentElement, { attributeFilter: ['data-skin'] });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paintNow);

$('account-name').textContent = user.display_name;
$('account-role').textContent = ROLE_LABEL[user.role_key];
$('accounts-link').textContent = user.role_key === 'admin' ? '修改密码与管理账号' : '修改本人密码';
$('logout-btn').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try { await logout(); } catch { button.disabled = false; }
});
