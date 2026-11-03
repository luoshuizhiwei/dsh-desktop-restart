// 2026-11-03 issue #6：交互相位必须压过上一次操作的终态。
//
// 真机现象：上一次重启成功后留下 `op.result = "ok"`，此后点按钮进入「确认重启？」
// 时颜色变红了，文字却仍是「重启」—— 因为 labelOf() 把 op.result 排在了 phase
// 之前，ok 分支一到就短路，warn/confirm 两个分支永远走不到。
//
// 反向约束（旧用例守着）：`done` 相位不能盖掉失败/未知的终态结论 ——
// 所以只有 transient 相位（warn/confirm/restarting/error）可以优先。
//
// 运行：node scripts/label-order-regression.mjs
import assert from 'node:assert/strict';
import { makeHarness, reply, flush, statusBody, buttons, textContent } from './fixtures/client-harness.mjs';

let passed = 0;

/** 构造一个「上一次重启已成功」的终态记录。 */
function okOp() {
  return {
    id: 'label-order-fixture',
    schema: 1,
    phase: 'done',
    result: 'ok',
    reason: null,
    stages: {},
    ageMs: 1000,
    helperAlive: false,
    helperVerified: true,
    needsManualCheck: false,
    busy: false,
  };
}

function footButton(tree) {
  return buttons(tree).find((button) => button.props.className === 'dshdr-foot-badge') ?? null;
}

// ── A. op.ok 之后首击必须显示「确认重启？」──────────────────────────────
{
  const h = makeHarness(async () => reply(200, statusBody('off', { restartOp: okOp() })), { language: 'zh-CN' });
  await flush();
  const instance = h.render(h.sidebarComponent);
  await flush();
  let tree = h.render(h.sidebarComponent, instance.hook).tree;

  // 先确认基线：终态 ok、未点击时，按钮应显示常态词「重启」。
  assert.match(textContent(tree), /重启/u, 'A: 基线应显示常态词');
  assert.doesNotMatch(textContent(tree), /确认重启|仍要重启/u, 'A: 基线不得显示确认态文案');

  const button = footButton(tree);
  assert.ok(button !== null, 'A: 侧栏底部按钮应存在');
  assert.notEqual(button.props.disabled, true, 'A: 终态 ok 之后按钮应可点');
  button.props.onClick();

  tree = h.render(h.sidebarComponent, instance.hook).tree;
  const text = textContent(tree);
  assert.match(text, /确认重启/u, 'A: 首击后必须显示「确认重启？」（issue #6 的原始缺陷是这里仍是「重启」）');
  assert.doesNotMatch(text, /仍要重启/u, 'A: 无任务在跑时不应进入「仍要重启」');
  h.dispose();
  passed += 1;
  console.log(`ok ${passed} - A 终态 ok 之后首击显示「确认重启？」`);
}

// ── B. 反向约束：done 相位不得盖掉失败的终态结论 ───────────────────────
{
  const failedOp = { ...okOp(), result: 'failed', reason: 'relaunch-failed', busy: false };
  const h = makeHarness(async () => reply(200, statusBody('off', { restartOp: failedOp })), { language: 'zh-CN' });
  await flush();
  const instance = h.render(h.sidebarComponent);
  await flush();
  const tree = h.render(h.sidebarComponent, instance.hook).tree;
  const text = textContent(tree);
  assert.match(text, /重试|retry/iu, 'B: 失败终态必须显示重试语义');
  assert.doesNotMatch(text, /已排程|scheduled|已安排/iu, 'B: done 相位不得盖掉失败结论');
  h.dispose();
  passed += 1;
  console.log(`ok ${passed} - B done 相位不盖掉失败结论`);
}

console.log(`\nlabel order regression: ${passed} checks passed`);