import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceClient } from '../src/http.mjs';
import { Archive } from '../src/archive.mjs';
import { fixtureSource } from '../src/fixture-source.mjs';
import { collect, receive } from '../src/app.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8'));
const source = await fixtureSource(fixture);

// 演示在本地副本上补充字段级资料，不改变公开摘要原文的示例形状。
source.replace('/passports/public/records/BP100', {
  body: {
    ...fixture.resources['/passports/public/records/BP100'].body,
    fields: {
      chemistry: 'LFP',
      capacityWh: '120',
      parts: ['cathode', 'anode'],
      serial: 'SN-1',
    },
  },
});

const directory = await mkdtemp(join(tmpdir(), 'passport-scope-'));
const archive = await new Archive(directory).start();
try {
  const client = new SourceClient(source.url);
  const summary = await collect(client, archive, fixture.scope);
  console.log('公开摘要收件：', JSON.stringify(summary.counts));
  for (const purpose of ['repair', 'dismantle']) {
    const result = await receive(client, archive, purpose);
    console.log(purpose + ' 用途字段级结果：');
    console.log(JSON.stringify(result, null, 2));
    if (result.counts.error) process.exitCode = 1;
  }
  console.log('已保存原文与收件记录：', archive.records(fixture.scope).length);
  if (!summary.complete) process.exitCode = 1;
} finally { archive.close(); await source.close();  await rm(directory, { recursive: true, force: true }); }
