// 2026-11-03 issue #3 回归用例
//
// 两件事：
//   A. confirm 态必须是危险色 —— 用户看不到文字变化时，颜色是唯一的信号。
//   B. 皮肤接管账号菜单时不再注入 —— 两个按钮互相挤位，谁都不该硬挤。
//
// 运行：node --experimental-vm-modules scripts/issue3-regression.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeHarness, reply, flush, statusBody } from './fixtures/client-harness.mjs';
import { accountMenuDOM } from './fixtures/account-menu-dom.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');
let passed = 0;

// ── A1. confirm 态配色：三个入口都必须有独立的 confirm 规则 ────────────────
{
  const rules = {
    'sidebar footer': '.dshdr-foot-badge[data-phase=confirm]',
    'session header': '.dshdr-trigger[data-phase=confirm]',
  };
  for (const [entry, selector] of Object.entries(rules)) {
    const at = source.indexOf(selector + '{');
    assert.ok(at !== -1, `A1: ${entry} 必须有 confirm 态样式规则`);
    const rule = source.slice(at, source.indexOf('}', at) + 1);
    assert.match(rule, /state-error-primary/u, `A1: ${entry} 的 confirm 态必须用危险色`);
    assert.doesNotMatch(rule, /label-primary/u, `A1: ${entry} 的 confirm 态不得与 idle 同色（那是 issue #3 的原始缺陷）`);
  }
  passed += 1;
  console.log(`ok ${passed} - A1 confirm 态在侧栏底部与标题栏都改用危险色`);
}

// ── A2. 账号菜单注入项的 confirm 态也要上色 ───────────────────────────────
{
  const anchor = source.indexOf('button.style.color = action.phase === "warn"');
  assert.ok(anchor !== -1, 'A2: 账号菜单注入项的染色语句应存在');
  const line = source.slice(anchor, source.indexOf('\n', anchor));
  assert.ok(line.includes('"confirm"'), 'A2: 账号菜单注入项在 confirm 态也必须染色');
  passed += 1;
  console.log(`ok ${passed} - A2 账号菜单注入项 confirm 态染色`);
}

// ── B1. 皮肤接管时，click 之后不应注入任何按钮 ─────────────────────────────
{
  const dom = accountMenuDOM();
  // 模拟皮肤**真的在重绘**：菜单视口里有皮肤自己的容器。这是判据的全部 ——
  // 只看 body 标记是不够的（关掉「重绘账户区」后标记还在，容器没了）。
  const skinBox = dom.document.createElement('div');
  skinBox.className = 'dsh-claude-account-inject';
  dom.viewport.insertBefore(skinBox, dom.viewport.firstElementChild);

  const h = makeHarness(async () => reply(200, statusBody('off')), { dom });
  await flush();
  dom.open();
  await flush();
  h.fireFrame();
  await flush();

  assert.equal(dom.injected().length, 0, 'B1: 皮肤正在重绘菜单时不得注入按钮');
  h.dispose();
  passed += 1;
  console.log(`ok ${passed} - B1 皮肤重绘菜单时不注入（避免两个按钮互相挤位）`);
}

// ── B1b. 皮肤装了但关掉重绘：必须照常注入（真机 11-03 回归）─────────────
{
  const dom = accountMenuDOM();
  // body 有皮肤标记，但菜单里没有皮肤容器 —— 用户关掉了「重绘账户区」。
  dom.document.body.attributes = dom.document.body.attributes ?? new Map();
  Object.defineProperty(dom.document.body, 'hasAttribute', {
    value: key => dom.document.body.attributes.has(key),
    configurable: true,
  });
  dom.document.body.attributes.set('data-dsh-claude-style', '');

  const h = makeHarness(async () => reply(200, statusBody('off')), { dom });
  await flush();
  dom.open();
  await flush();
  h.fireFrame();
  await flush();

  assert.equal(dom.injected().length, 1, 'B1b: 关掉皮肤重绘后必须恢复注入（否则入口凭空消失）');
  assert.equal(dom.viewport.firstElementChild, dom.injected()[0], 'B1b: 注入项位于视口首位');
  h.dispose();
  passed += 1;
  console.log(`ok ${passed} - B1b 皮肤在但未重绘时照常注入`);
}

// ── B2. 无皮肤时行为不变（防回归）────────────────────────────────────────
{
  const dom = accountMenuDOM();
  const h = makeHarness(async () => reply(200, statusBody('off')), { dom });
  await flush();
  dom.open();
  await flush();
  h.fireFrame();
  await flush();

  assert.equal(dom.injected().length, 1, 'B2: 无皮肤时必须照常注入');
  assert.equal(dom.viewport.firstElementChild, dom.injected()[0], 'B2: 仍位于 viewport 首位');
  h.dispose();
  passed += 1;
  console.log(`ok ${passed} - B2 无皮肤时注入行为不变`);
}

console.log(`\nissue3 regression: ${passed} checks passed`);
