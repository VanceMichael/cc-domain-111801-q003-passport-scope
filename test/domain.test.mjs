import test from 'node:test';
import assert from 'node:assert/strict';
import { interpret } from '../src/interpret.mjs';
import { assess, summarize } from '../src/receiving.mjs';
const raw = {"passport": "BP100", "purpose": "public", "manufacturer": "合成制造厂", "model": "CELL-A", "capacityWh": "120", "public": true};
const scope = "public";

test('领域记录保留明确的来源上下文', () => {
  const actual = interpret(raw);
  assert.equal(actual.purpose, raw.purpose);
  assert.equal(assess(actual, [actual], scope).status, 'accepted');
});
test('同一业务依据发生矛盾时不能覆盖接收', () => {
  const first = interpret(raw);
  const changed = interpret({"passport": "BP100", "purpose": "public", "manufacturer": "合成制造厂", "model": "OTHER-MODEL", "capacityWh": "120", "public": true});
  assert.equal(assess(changed, [first], scope).status, 'conflict');
});
test('空目录与范围外内容不声明完成', () => {
  assert.equal(summarize([]).complete, false);
  const outcome = assess(interpret(raw), [], 'other-scope');
  assert.equal(summarize([outcome]).complete, false);
  assert.equal(summarize([outcome]).counts.outside, 1);
});
test('未知数值不得转为零或可接收记录', () => {
  assert.throws(() => interpret({ ...raw, capacityWh: "unknown" }));
  assert.throws(() => interpret({ ...raw, capacityWh: "" }));
  assert.throws(() => interpret({ ...raw, capacityWh: "NaN" }));
  assert.throws(() => interpret({ ...raw, capacityWh: "Infinity" }));
});
