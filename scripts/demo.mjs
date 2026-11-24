import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceClient } from '../src/http.mjs';
import { Archive } from '../src/archive.mjs';
import { fixtureSource } from '../src/fixture-source.mjs';
import { collect } from '../src/app.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8'));
const source = await fixtureSource(fixture);

const directory = await mkdtemp(join(tmpdir(), 'passport-scope-'));
const archive = await new Archive(directory).start();
try {
  // 公开摘要：原有公开收件边界
  const publicResult = await collect(new SourceClient(source.url), archive, fixture.scope);
  console.log('== 公开摘要收件 ==');
  console.log(JSON.stringify({ complete: publicResult.complete, counts: publicResult.counts }, null, 2));

  // 维修用途：只接收维修许可下的字段
  const repair = await collect(new SourceClient(source.url), archive, 'repair');
  console.log('\n== 维修用途字段级接收 ==');
  console.log(JSON.stringify({
    complete: repair.complete,
    delivered: repair.passports[0].delivered.map(item => ({ field: item.field, value: item.value })),
    verifications: repair.passports[0].verifications.map(item => item.field),
    missingBasis: repair.passports[0].missingBasis.map(item => ({ field: item.field, treatment: item.treatment })),
    currentPackage: repair.currentPackage.fields.map(item => item.field),
  }, null, 2));

  // 拆解用途：verify-only 只给核验结论，派生部件列表随上游许可联动
  const dismantle = await collect(new SourceClient(source.url), archive, 'dismantle');
  console.log('\n== 拆解用途字段级接收 ==');
  console.log(JSON.stringify({
    complete: dismantle.complete,
    delivered: dismantle.passports[0].delivered.map(item => ({ field: item.field, value: item.value })),
    verifications: dismantle.passports[0].verifications.map(item => ({ field: item.field, treatment: item.treatment })),
    missingBasis: dismantle.passports[0].missingBasis.map(item => ({ field: item.field, treatment: item.treatment })),
    currentPackage: dismantle.currentPackage.fields.map(item => item.field),
  }, null, 2));

  console.log('\n已保存原文证据：', archive.records(fixture.scope).length, '份公开收据 +',
    archive.fieldReceipts('repair').length + archive.fieldReceipts('dismantle').length, '份字段收据');
  if (!publicResult.complete) process.exitCode = 1;
} finally {
  archive.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
