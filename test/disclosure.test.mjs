import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceClient } from '../src/http.mjs';
import { fixtureSource } from '../src/fixture-source.mjs';
import { Archive } from '../src/archive.mjs';
import {
  interpretRelations, resolveDisclosures, reconcilePrevious, interpretDisclosures,
} from '../src/disclosure.mjs';
import { assessPackage, summarizePackages } from '../src/receiving.mjs';
import { receive, refresh, collect } from '../src/app.mjs';

const disclosureFixture = {
  scope: 'public',
  resources: {
    '/passports/public': {
      body: {
        purpose: 'public',
        passports: [{
          id: 'BP200',
          href: '/passports/public/records/BP200',
          relations: '/passports/public/relations/BP200',
          purposes: ['repair', 'dismantle'],
        }],
      },
    },
    '/passports/public/records/BP200': {
      body: {
        passport: 'BP200',
        purpose: 'public',
        fields: {
          chemistry: 'LFP',
          capacityWh: '120',
          parts: ['cathode', 'anode'],
          serial: 'SN-1',
        },
      },
    },
    '/passports/public/relations/BP200': {
      body: {
        disclosures: [
          { field: 'chemistry', purpose: 'repair', proof: 'P5' },
          { field: 'capacityWh', purpose: 'repair', proof: 'P2' },
          { field: 'parts', purpose: 'repair', proof: 'P3', derivedFrom: ['chemistry', 'capacityWh'] },
          { field: 'serial', purpose: 'dismantle', proof: 'P1' },
          { field: 'capacityWh', purpose: 'dismantle', proof: 'P2' },
        ],
        proofs: [
          { id: 'P1', mode: 'content' },
          { id: 'P2', mode: 'content', dependsOn: ['P4'] },
          { id: 'P3', mode: 'content' },
          { id: 'P4', mode: 'verify-only', conclusion: { verified: true, basis: 'registry' } },
          { id: 'P5', mode: 'verify-only', conclusion: { verified: true, chemistry: 'LFP' } },
        ],
      },
    },
  },
};

async function withSource(fixture, run) {
  const source = await fixtureSource(fixture);
  try { await run(source); } finally { await source.close(); }
}

test('字段内容、仅核验结论与缺少授权依据分别表示', async () => {
  const fixture = structuredClone(disclosureFixture);
  fixture.resources['/passports/public/relations/BP200'].body.disclosures.push(
    { field: 'serial', purpose: 'repair', proof: 'P1', approved: false },
  );
  await withSource(fixture, async source => {
    const directory = await mkdtemp(join(tmpdir(), 'fields-'));
    const archive = await new Archive(directory).start();
    try {
      const result = await receive(new SourceClient(source.url), archive, 'repair');
      const [outcome] = result.outcomes;
      assert.equal(outcome.status, 'pending');
      // chemistry 的证明只允许核验：只留下结论，不交付原始内容。
      assert.deepEqual(outcome.content, { capacityWh: '120' });
      assert.deepEqual(Object.keys(outcome.conclusions).sort(), ['chemistry']);
      assert.deepEqual(outcome.proofConclusions.P4, { verified: true, basis: 'registry' });
      // 派生部件列表依赖仅核验字段，不能因此把内容带出。
      assert.deepEqual(outcome.withheld.map(item => item.field), ['parts']);
      // 新申请未通过的字段仍在待授权列表中，不是不存在，也不是核验失败。
      assert.deepEqual(outcome.pending.map(item => item.field), ['serial']);
      assert.equal(outcome.evidence.some(item => item.field === 'serial' && item.outcome === 'pending'), true);
      // 待授权字段不进入当前交付，但同用途其他已获批字段仍可交付。
      const current = archive.currentDelivery('repair', 'BP200');
      assert.deepEqual(current.record.content, { capacityWh: '120' });
      assert.equal(current.record.content.serial, undefined);
      assert.deepEqual(Object.keys(current.record.conclusions).sort(), ['chemistry']);
    } finally { archive.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

test('维修与拆解看到各自用途的字段包，互不带入全量原文', async () => {
  await withSource(disclosureFixture, async source => {
    const client = new SourceClient(source.url);
    const directory = await mkdtemp(join(tmpdir(), 'purposes-'));
    const archive = await new Archive(directory).start();
    try {
      const repair = await receive(client, archive, 'repair');
      const dismantle = await receive(client, archive, 'dismantle');
      // 维修用途的化学字段只允许核验，不能把原文带入；容量字段可交付。
      assert.deepEqual(repair.outcomes[0].content, { capacityWh: '120' });
      assert.deepEqual(Object.keys(repair.outcomes[0].conclusions).sort(), ['chemistry']);
      assert.deepEqual(Object.keys(dismantle.outcomes[0].content).sort(), ['capacityWh', 'serial']);
      assert.equal(repair.outcomes[0].content.serial, undefined);
      assert.equal(dismantle.outcomes[0].content.chemistry, undefined);
      assert.deepEqual(Object.keys(archive.currentDelivery('repair', 'BP200').record.content), ['capacityWh']);
      assert.deepEqual(Object.keys(archive.currentDelivery('dismantle', 'BP200').record.content).sort(), ['capacityWh', 'serial']);
    } finally { archive.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

test('来源隐藏字段后当前交付移除该字段，但保留当时取得的证据', async () => {
  await withSource(disclosureFixture, async source => {
    const client = new SourceClient(source.url);
    const directory = await mkdtemp(join(tmpdir(), 'hide-'));
    const archive = await new Archive(directory).start();
    try {
      const first = await receive(client, archive, 'dismantle');
      assert.deepEqual(Object.keys(first.outcomes[0].content).sort(), ['capacityWh', 'serial']);
      const digest = first.outcomes[0].digest;
      const hidden = structuredClone(disclosureFixture.resources['/passports/public/relations/BP200'].body);
      hidden.disclosures = hidden.disclosures.map(item =>
        item.purpose === 'dismantle' ? { ...item, hidden: true } : item);
      source.replace('/passports/public/relations/BP200', { body: hidden });
      const second = await refresh(client, archive, 'dismantle');
      assert.equal(second.outcomes[0].status, 'withheld');
      assert.equal(second.outcomes[0].content.serial, undefined);
      assert.equal(archive.currentDelivery('dismantle', 'BP200'), undefined);
      // 旧原文仍在证据库中可读，撤销的是当前交付，不是历史事实。
      assert.equal((await archive.original(digest)).length > 0, true);
      // 当时的字段级结果仍作为历史收据保存。
      assert.equal(archive.packages('dismantle').length, 2);
    } finally { archive.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

test('派生部件列表随来源字段失去许可而一并移除', async () => {
  const relations = {
    disclosures: [
      { field: 'chemistry', purpose: 'repair', proof: 'P1', hidden: true },
      { field: 'capacityWh', purpose: 'repair', proof: 'P1' },
      { field: 'parts', purpose: 'repair', proof: 'P1', derivedFrom: ['chemistry', 'capacityWh'] },
    ],
    proofs: [{ id: 'P1', mode: 'content' }],
  };
  const pkg = resolveDisclosures({
    passport: 'BP200', purpose: 'repair',
    values: { chemistry: 'LFP', capacityWh: '120', parts: ['cathode'] }, relations,
  });
  assert.deepEqual(pkg.content, { capacityWh: '120' });
  assert.deepEqual(pkg.withheld.map(item => item.field), ['chemistry', 'parts']);
  assert.equal(pkg.withheld.find(item => item.field === 'parts').reason, 'derived-from-withheld');
});

test('许可收缩只影响该用途，其他用途合法取得的资料不受误伤', async () => {
  await withSource(disclosureFixture, async source => {
    const client = new SourceClient(source.url);
    const directory = await mkdtemp(join(tmpdir(), 'shrink-'));
    const archive = await new Archive(directory).start();
    try {
      await receive(client, archive, 'repair');
      await receive(client, archive, 'dismantle');
      const contracted = structuredClone(disclosureFixture.resources['/passports/public/relations/BP200'].body);
      contracted.disclosures = contracted.disclosures.filter(item => item.purpose !== 'repair');
      source.replace('/passports/public/relations/BP200', { body: contracted });
      const refreshed = await refresh(client, archive, 'repair');
      assert.equal(refreshed.outcomes[0].status, 'withheld');
      assert.equal(archive.currentDelivery('repair', 'BP200'), undefined);
      // 拆解用途的交付仍然可读。
      assert.deepEqual(Object.keys(archive.currentDelivery('dismantle', 'BP200').record.content).sort(), ['capacityWh', 'serial']);
    } finally { archive.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

test('证明暂时不可取不写成核验失败，也不冒充字段不存在', async () => {
  const relations = {
    disclosures: [{ field: 'chemistry', purpose: 'repair', proof: 'P1' }],
    proofs: [{ id: 'P1', mode: 'content', available: false }],
  };
  const pkg = resolveDisclosures({
    passport: 'BP200', purpose: 'repair', values: { chemistry: 'LFP' }, relations,
  });
  assert.deepEqual(pkg.content, {});
  assert.deepEqual(pkg.pending, [{ field: 'chemistry', reason: 'proof-unavailable', proof: 'P1' }]);
  assert.deepEqual(pkg.conclusions, {});
  assert.equal(assessPackage(pkg), 'pending');
});

test('用途外引用不领取，来源边界不外扩', async () => {
  const fixture = structuredClone(disclosureFixture);
  fixture.resources['/passports/public/records/BP200'].body.fields = { chemistry: 'LFP' };
  await withSource(fixture, async source => {
    const directory = await mkdtemp(join(tmpdir(), 'outside-'));
    const archive = await new Archive(directory).start();
    try {
      const result = await receive(new SourceClient(source.url), archive, 'public');
      assert.equal(result.outcomes[0].status, 'outside');
      assert.equal(source.accesses.some(item => item.path === '/passports/public/records/BP200'), false);
    } finally { archive.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

test('关联声明可独立解释且拒绝重复字段', () => {
  assert.equal(interpretRelations, interpretDisclosures);
  assert.throws(() => interpretRelations({ disclosures: [{ field: 'a', purpose: 'p' }, { field: 'a', purpose: 'p' }], proofs: [] }));
  assert.throws(() => interpretRelations({ disclosures: [], proofs: [{ id: 'P1', mode: 'raw' }] }));
});

test('旧交付中已不再披露的字段会被回收为当前不可交付', () => {
  const pkg = resolveDisclosures({
    passport: 'BP200', purpose: 'repair', values: { chemistry: 'LFP' },
    relations: { disclosures: [], proofs: [] },
  });
  const reconciled = reconcilePrevious(pkg, { content: { chemistry: 'LFP' } });
  assert.deepEqual(reconciled.content, {});
  assert.deepEqual(reconciled.withheld, [{ field: 'chemistry', reason: 'no-longer-disclosed' }]);
});

test('仅核验结论随许可收缩一起退出当前交付', () => {
  const pkg = resolveDisclosures({
    passport: 'BP200', purpose: 'repair',
    relations: { disclosures: [], proofs: [] },
  });
  const reconciled = reconcilePrevious(pkg, { conclusions: { chemistry: { verified: true } } });
  assert.deepEqual(reconciled.conclusions, {});
  assert.deepEqual(reconciled.withheld, [{ field: 'chemistry', reason: 'no-longer-disclosed' }]);
});

test('现有公开摘要领取流程保持可用', async () => {
  const fixture = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8'));
  await withSource(fixture, async source => {
    const directory = await mkdtemp(join(tmpdir(), 'legacy-'));
    const archive = await new Archive(directory).start();
    try {
      const result = await collect(new SourceClient(source.url), archive, 'public');
      assert.equal(result.complete, true);
      assert.equal(summarizePackages([]).complete, false);
    } finally { archive.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
