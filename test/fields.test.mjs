import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceClient } from '../src/http.mjs';
import { fixtureSource } from '../src/fixture-source.mjs';
import { Archive } from '../src/archive.mjs';
import { collect } from '../src/app.mjs';
import { interpretRelations, evaluateFields, interpretFieldDocument, TREATMENTS } from '../src/disclosures.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8'));
const relationsPath = '/passports/public/relations/BP100';
const p1Path = '/passports/public/evidence/BP100/P1';
const p2Path = '/passports/public/evidence/BP100/P2';
const p3Path = '/passports/public/evidence/BP100/P3';

async function withHarness(run) {
  const source = await fixtureSource(fixture);
  const directory = await mkdtemp(join(tmpdir(), 'fields-'));
  const archive = await new Archive(directory).start();
  try {
    await run(source, archive, () => new SourceClient(source.url));
  } finally {
    archive.close();
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('维修与拆解按各自获批用途得到不同的字段级资料', async () => {
  await withHarness(async (source, archive, client) => {
    const repair = await collect(client(), archive, 'repair');
    const dismantle = await collect(client(), archive, 'dismantle');

    assert.equal(repair.complete, true);
    assert.deepEqual(repair.passports[0].delivered.map(item => item.field), ['capacityWh']);
    assert.equal(repair.passports[0].delivered[0].value, '120');

    // 拆解拿到维修拿不到的 chemistry 核验结论与部件列表
    const dismantleFields = dismantle.passports[0].delivered.map(item => item.field).sort();
    assert.deepEqual(dismantleFields, ['capacityWh', 'partsList']);
    assert.deepEqual(dismantle.passports[0].verifications.map(item => item.field), ['chemistry']);
    assert.equal(dismantle.passports[0].verifications[0].treatment, TREATMENTS.VERIFIED_ONLY);
  });
});

test('verify-only 证明只保留核验结论，字段原文不进入任何采集包', async () => {
  await withHarness(async (source, archive, client) => {
    const dismantle = await collect(client(), archive, 'dismantle');
    const chemistry = dismantle.passports[0].verifications[0];
    assert.equal(chemistry.field, 'chemistry');
    assert.equal('value' in chemistry, false);

    // 当前可用包里没有 chemistry，也没有 verify-only 证明原文及其内部备注
    const current = dismantle.currentPackage;
    assert.equal(current.fields.some(item => item.field === 'chemistry'), false);
    const serialized = JSON.stringify(current);
    assert.equal(serialized.includes('internalNote'), false);
    assert.equal(serialized.includes('全量备注'), false);
    // verify-only 字段的独立值键不得出现在任何交付字段中
    assert.equal(current.fields.some(item => item.value === 'LFP'), false);

    // 但当时如何取得核验结论的证据（原文字节与收据）仍然保留
    const receipts = archive.fieldReceipts('dismantle');
    const chemistryReceipt = receipts.find(item => item.field === 'chemistry');
    assert.equal(chemistryReceipt.decision.treatment, TREATMENTS.VERIFIED_ONLY);
    const original = await archive.original(chemistryReceipt.digest);
    assert.equal(JSON.parse(original.toString()).value, 'LFP');
  });
});

test('同一内容摘要在维修与拆解两个用途下分别取得且互不污染', async () => {
  await withHarness(async (source, archive, client) => {
    const repair = await collect(client(), archive, 'repair');
    const dismantle = await collect(client(), archive, 'dismantle');
    const repairCapacity = repair.passports[0].delivered.find(item => item.field === 'capacityWh');
    const dismantleCapacity = dismantle.passports[0].delivered.find(item => item.field === 'capacityWh');
    assert.equal(repairCapacity.digest, dismantleCapacity.digest);

    // 两份用途收据独立存在，各自记录自己的授权依据
    const repairReceipts = archive.fieldReceipts('repair');
    const dismantleReceipts = archive.fieldReceipts('dismantle');
    assert.ok(repairReceipts.every(item => item.scope === 'repair'));
    assert.ok(dismantleReceipts.every(item => item.scope === 'dismantle'));
    assert.equal(repairReceipts.some(item => item.field === 'partsList'), false);
  });
});

test('内部全量账号可见的额外字段不会被带进部门采集包', async () => {
  await withHarness(async (source, archive, client) => {
    const dismantle = await collect(client(), archive, 'dismantle');
    const serialized = JSON.stringify(dismantle);
    assert.equal(serialized.includes('internalNote'), false);
    // 只领取来源披露过的字段，没有声明的字段绝不补造
    assert.equal(dismantle.passports[0].delivered.some(item => item.field === 'supplierTrace'), false);
  });
});

test('来源把字段从可见改为隐藏后撤出当前包，但保留历史证据', async () => {
  await withHarness(async (source, archive, client) => {
    const first = await collect(client(), archive, 'repair');
    assert.deepEqual(first.currentPackage.fields.map(item => item.field), ['capacityWh']);
    const beforeDigest = first.passports[0].delivered[0].digest;

    const updated = structuredClone(fixture.resources[relationsPath].body);
    updated.disclosures = updated.disclosures.map(item =>
      item.field === 'capacityWh' && item.purpose === 'repair' ? { ...item, visible: false } : item);
    source.replace(relationsPath, { body: updated });

    const second = await collect(client(), archive, 'repair');
    const withdrawn = second.passports[0].missingBasis.find(item => item.field === 'capacityWh');
    assert.equal(withdrawn.treatment, TREATMENTS.GRANT_WITHDRAWN);
    assert.equal(withdrawn.previouslyDelivered, true);
    // 当前可用包不再包含失去许可的字段
    assert.deepEqual(second.currentPackage.fields, []);

    // 历史收据与原文证据仍可复查，且不被覆盖
    const receipts = archive.fieldReceipts('repair').filter(item => item.field === 'capacityWh');
    assert.equal(receipts.length, 2);
    assert.equal(receipts[0].decision.treatment, TREATMENTS.DELIVERED);
    assert.equal(receipts[1].decision.treatment, TREATMENTS.GRANT_WITHDRAWN);
    assert.equal(await archive.original(beforeDigest).then(buffer => buffer.length > 0), true);
  });
});

test('隐藏上游字段时派生的部件列表一并撤出，只删最后一列不够', async () => {
  await withHarness(async (source, archive, client) => {
    const first = await collect(client(), archive, 'dismantle');
    assert.deepEqual(first.currentPackage.fields.map(item => item.field).sort(), ['capacityWh', 'partsList']);

    const updated = structuredClone(fixture.resources[relationsPath].body);
    updated.disclosures = updated.disclosures.filter(item =>
      !(item.field === 'chemistry' && item.purpose === 'dismantle'));
    source.replace(relationsPath, { body: updated });

    const second = await collect(client(), archive, 'dismantle');
    const withheld = second.passports[0].missingBasis.find(item => item.field === 'partsList');
    assert.equal(withheld.treatment, TREATMENTS.WITHHELD_DERIVED);
    assert.deepEqual(withheld.blockedSources, ['chemistry']);
    // 派生内容（含 LFP 字样）整体撤出当前包
    assert.equal(second.currentPackage.fields.some(item => item.field === 'partsList'), false);
    assert.equal(JSON.stringify(second.currentPackage).includes('LFP'), false);
  });
});

test('一个用途的许可收缩不误伤另一用途合法取得的资料', async () => {
  await withHarness(async (source, archive, client) => {
    await collect(client(), archive, 'repair');
    await collect(client(), archive, 'dismantle');

    const updated = structuredClone(fixture.resources[relationsPath].body);
    updated.disclosures = updated.disclosures.map(item =>
      item.field === 'capacityWh' && item.purpose === 'repair' ? { ...item, visible: false } : item);
    source.replace(relationsPath, { body: updated });

    await collect(client(), archive, 'repair');
    const dismantle = await collect(client(), archive, 'dismantle');
    // 拆解用途下的 capacityWh 与 partsList 仍然合法可交付
    assert.deepEqual(dismantle.currentPackage.fields.map(item => item.field).sort(), ['capacityWh', 'partsList']);
  });
});

test('待批授权申请进入缺失授权依据，不被当成字段不存在或核验失败', async () => {
  await withHarness(async (source, archive, client) => {
    const repair = await collect(client(), archive, 'repair');
    const pending = repair.passports[0].missingBasis.find(item => item.field === 'chemistry');
    assert.equal(pending.treatment, TREATMENTS.PENDING_GRANT);
    assert.equal(pending.requestStatus, 'pending');
    // 待批不影响本次流程宣告完成，也不产生核验失败结论
    assert.equal(repair.complete, true);
    assert.equal(repair.passports[0].verifications.length, 0);
    assert.equal(repair.counts['verification-failed'] ?? 0, 0);
  });
});

test('证明暂时不可取与核验失败严格区分', async () => {
  await withHarness(async (source, archive, client) => {
    // 场景一：503 暂时不可用 -> proof-unavailable，不写成核验失败
    source.fail(p1Path, 503, 3);
    const unavailable = await collect(client(), archive, 'dismantle');
    const decision = unavailable.passports[0].missingBasis.find(item => item.field === 'chemistry');
    assert.equal(decision.treatment, TREATMENTS.PROOF_UNAVAILABLE);
    assert.equal(decision.temporary, true);
    assert.equal(unavailable.complete, false);
    assert.equal(unavailable.counts['verification-failed'] ?? 0, 0);
  });

  await withHarness(async (source, archive, client) => {
    // 场景二：摘要与声明不符 -> 真正的核验失败
    const wrong = structuredClone(fixture.resources[p1Path].body);
    wrong.value = 'NMC';
    source.replace(p1Path, { body: wrong });
    const failed = await collect(client(), archive, 'dismantle');
    const verification = failed.passports[0].verifications.find(item => item.field === 'chemistry');
    assert.equal(verification.treatment, TREATMENTS.VERIFICATION_FAILED);
    assert.notEqual(verification.observedDigest, verification.declaredDigest);
    assert.equal(failed.complete, false);
  });
});

test('403 缺权与 404 缺件不被自行解释为业务删除', async () => {
  await withHarness(async (source, archive, client) => {
    source.replace(p2Path, { status: 403, body: { error: '无权领取' } });
    const repair = await collect(client(), archive, 'repair');
    const missing = repair.passports[0].missingBasis.find(item => item.field === 'capacityWh');
    assert.equal(missing.treatment, TREATMENTS.PROOF_UNAVAILABLE);
    assert.match(missing.reason, /暂时不可取/);
    // 历史上没有交付过，就不能出现在当前可用包
    assert.deepEqual(repair.currentPackage.fields, []);
  });
});

test('流程只访问来源已声明授予的资源，不猜测不越界', async () => {
  await withHarness(async (source, archive, client) => {
    await collect(client(), archive, 'dismantle');
    const accessed = new Set(source.accesses.map(item => item.path));
    // 只访问目录、记录、披露关系以及披露中显式声明的证明
    assert.ok(accessed.has('/passports/public'));
    assert.ok(accessed.has(relationsPath));
    assert.ok(accessed.has(p1Path));
    assert.ok(accessed.has(p2Path));
    assert.ok(accessed.has(p3Path));
    // P4 是隐藏披露引用的证明，当前用途无权，不应主动尝试
    assert.equal(accessed.has('/passports/public/evidence/BP100/P4'), false);
  });
});

test('披露关系解释拒绝重复、缺证明和模式不一致的来源数据', () => {
  const valid = fixture.resources[relationsPath].body;
  assert.doesNotThrow(() => interpretRelations(valid));
  assert.throws(() => interpretRelations({ ...valid, disclosures: [{ ...valid.disclosures[0], proof: 'NOPE' }] }), /未声明/);
  const duplicated = { ...valid, disclosures: [...valid.disclosures, valid.disclosures[1]] };
  assert.throws(() => interpretRelations(duplicated), /重复/);
  const mismatched = structuredClone(valid);
  mismatched.disclosures[0] = { ...mismatched.disclosures[0], mode: 'deliver' };
  assert.throws(() => interpretRelations(mismatched), /模式不一致/);
});

test('字段资料解释拒绝空值与非字符串数组', () => {
  const body = fixture.resources[p2Path].body;
  assert.equal(interpretFieldDocument(body).value, '120');
  assert.throws(() => interpretFieldDocument({ ...body, value: '' }), /字段内容/);
  assert.throws(() => interpretFieldDocument({ ...body, value: [] }), /字段内容/);
  assert.throws(() => interpretFieldDocument({ ...body, value: ['ok', ''] }), /字段内容/);
});

test('纯领域评估可独立复查全部处置分支', () => {
  const relations = interpretRelations(fixture.resources[relationsPath].body);
  const p1 = relations.proofs.get('P1');
  const p2 = relations.proofs.get('P2');
  const p3 = relations.proofs.get('P3');
  const observations = new Map([
    ['P1', { ok: true, digest: p1.digest, raw: null }],
    ['P2', { ok: true, digest: p2.digest, raw: { value: '120' } }],
    ['P3', { ok: true, digest: p3.digest, raw: { value: ['部件'] } }],
  ]);
  const dismantle = evaluateFields(relations, observations, [], 'dismantle');
  assert.equal(dismantle.find(item => item.field === 'chemistry').treatment, TREATMENTS.VERIFIED_ONLY);
  assert.equal(dismantle.find(item => item.field === 'partsList').treatment, TREATMENTS.DELIVERED);

  // chemistry 失去结论后，partsList 作为派生字段被撤出
  const degraded = new Map(observations);
  degraded.set('P1', { ok: false, reason: '503' });
  const after = evaluateFields(relations, degraded, [], 'dismantle');
  assert.equal(after.find(item => item.field === 'partsList').treatment, TREATMENTS.WITHHELD_DERIVED);

  const repair = evaluateFields(relations, observations, [], 'repair');
  assert.equal(repair.find(item => item.field === 'chemistry').treatment, TREATMENTS.PENDING_GRANT);
  assert.equal(repair.find(item => item.field === 'supplierTrace').treatment, TREATMENTS.GRANT_WITHDRAWN);
});
