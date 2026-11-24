import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export class Archive {
  constructor(directory) { this.directory = directory; }
  async start() {
    await mkdir(join(this.directory, 'objects'), { recursive: true });
    this.database = new DatabaseSync(join(this.directory, 'receipts.sqlite'));
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3003;');
    this.database.exec(`CREATE TABLE IF NOT EXISTS evidence (
      digest TEXT PRIMARY KEY, location TEXT NOT NULL, observed_at TEXT NOT NULL, size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (
      scope TEXT NOT NULL, business_key TEXT NOT NULL, digest TEXT NOT NULL, record TEXT NOT NULL,
      decision TEXT NOT NULL, PRIMARY KEY(scope,business_key,digest));
      CREATE TABLE IF NOT EXISTS field_receipts (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL, passport TEXT NOT NULL, field TEXT NOT NULL,
      digest TEXT, relation_digest TEXT NOT NULL, observed_at TEXT NOT NULL,
      decision TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_field_receipts_lookup
      ON field_receipts(scope, passport, field, seq);`);
    return this;
  }
  async preserve(document) {
    const digest = createHash('sha256').update(document.bytes).digest('hex');
    const destination = join(this.directory, 'objects', digest);
    const temporary = destination + '.' + process.pid + '.' + randomUUID();
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(document.bytes); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, destination);
    this.database.prepare('INSERT OR IGNORE INTO evidence VALUES(?,?,?,?)').run(digest, document.location, document.observedAt, document.bytes.length);
    return digest;
  }
  put(scope, key, digest, record, decision) {
    if (!this.database.prepare('SELECT digest FROM evidence WHERE digest=?').get(digest)) throw new Error('原文尚未保存');
    this.database.prepare('INSERT OR IGNORE INTO receipts VALUES(?,?,?,?,?)').run(scope, key, digest, JSON.stringify(record), JSON.stringify(decision));
  }
  records(scope) {
    return this.database.prepare('SELECT * FROM receipts WHERE scope=? ORDER BY business_key,digest').all(scope).map(row => ({ ...row, record: JSON.parse(row.record), decision: JSON.parse(row.decision) }));
  }
  // 字段级收据只追加：许可收缩后保留“当时如何取得结果”的证据，不用覆盖消除分歧
  putFieldReceipt(scope, passport, field, decision, { digest, relationDigest, observedAt }) {
    if (!this.database.prepare('SELECT digest FROM evidence WHERE digest=?').get(relationDigest)) throw new Error('披露关系原文尚未保存');
    // digest 为 null 表示该字段本轮没有可取回的证明（隐藏、待批、暂不可取等），无需证据落库
    if (digest !== null && !this.database.prepare('SELECT digest FROM evidence WHERE digest=?').get(digest)) throw new Error('证明原文尚未保存');
    this.database.prepare(`INSERT INTO field_receipts
      (scope, passport, field, digest, relation_digest, observed_at, decision)
      VALUES (?,?,?,?,?,?,?)`).run(scope, passport, field, digest, relationDigest, observedAt, JSON.stringify(decision));
  }
  fieldReceipts(scope) {
    return this.database.prepare('SELECT * FROM field_receipts WHERE scope=? ORDER BY seq').all(scope)
      .map(row => ({ ...row, decision: JSON.parse(row.decision) }));
  }
  // 当前可用包：每个用途+护照+字段只取最新一次结论，并剔除失去交付许可的字段
  currentPackage(scope) {
    const rows = this.database.prepare(`SELECT fr.* FROM field_receipts fr
      JOIN (SELECT passport, field, MAX(seq) AS max_seq FROM field_receipts WHERE scope=? GROUP BY passport, field) latest
      ON fr.passport = latest.passport AND fr.field = latest.field AND fr.seq = latest.max_seq
      WHERE fr.scope=? ORDER BY fr.passport, fr.field`).all(scope, scope);
    const fields = [];
    for (const row of rows) {
      const decision = JSON.parse(row.decision);
      if (decision.treatment !== 'delivered') continue;
      fields.push({
        passport: row.passport,
        field: row.field,
        value: decision.value,
        mode: decision.mode,
        proof: decision.proof,
        digest: row.digest,
        observedAt: row.observed_at,
      });
    }
    return { scope, fields };
  }
  async original(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('原文摘要无效');
    const content = await readFile(join(this.directory, 'objects', digest));
    if (createHash('sha256').update(content).digest('hex') !== digest) throw new Error('原文完整性校验失败');
    return content;
  }
  close() { this.database?.close(); }
}
