import { browse, retrieve, retrieveRelations } from './source.mjs';
import { interpret } from './interpret.mjs';
import { assess, summarize, assessPackage, summarizePackages } from './receiving.mjs';
import { resolveDisclosures, reconcilePrevious } from './disclosure.mjs';

export async function preview(client) {
  const manifest = await browse(client);
  const entries = [];
  for (const ref of manifest.references) {
    const document = await retrieve(client, ref);
    entries.push(interpret(document.raw));
  }
  return { context: manifest.context, entries };
}

export async function collect(client, archive, scope, operator) {
  const manifest = await browse(client);
  const outcomes = [];
  for (const reference of manifest.references) {
    let digest;
    try {
      const document = await retrieve(client, reference);
      digest = await archive.preserve(document);
      const record = interpret(document.raw);
      const prior = archive.records(scope).filter(item => item.decision.status === 'accepted').map(item => item.record);
      const decision = assess(record, prior, scope);
      if (operator && decision.status === 'accepted') decision.portal = await operator(record);
      archive.put(scope, decision.key ?? reference.identity, digest, record, decision);
      outcomes.push({ reference: reference.identity, digest, ...decision });
    } catch (error) {
      outcomes.push({ reference: reference.identity, digest, status: 'error', reason: error.message });
    }
  }
  return { context: manifest.context, ...summarize(outcomes) };
}

/**
 * 按已获批用途领取字段级资料。来源原文与关联声明分别保存为证据；
 * 当前交付只保留该用途仍获许可的字段；内容、仅核验结论与待授权依据分开返回。
 */
export async function receive(client, archive, purpose, { references } = {}) {
  return process(client, archive, purpose, references);
}

/**
 * 用途变更或许可收缩后重新形成当前交付。只撤销给定用途中不再获许可的字段，
 * 其他用途的交付保持原样；旧原文与旧收据不删除，可继续复查当时如何取得结果。
 */
export async function refresh(client, archive, purpose, { references } = {}) {
  return process(client, archive, purpose, references);
}

async function process(client, archive, purpose, references) {
  const manifest = await browse(client);
  const selected = references ?? manifest.references;
  const outcomes = [];
  for (const reference of selected) {
    let digest;
    try {
      if (reference.purposes && !reference.purposes.includes(purpose)) {
        // 来源未授予该用途时不发原文请求，也不尝试扩大访问范围；已有交付按撤销处理。
        archive.retract(purpose, reference.identity);
        outcomes.push({ reference: reference.identity, status: 'outside', reason: '用途不在来源声明的许可范围内' });
        continue;
      }
      const document = await retrieve(client, reference);
      const relations = await retrieveRelations(client, reference);
      digest = await archive.preserve(document);
      const relationDigest = await archive.preserve(relations);
      const previous = archive.currentDelivery(purpose, reference.identity)?.record;
      const pkg = reconcilePrevious(resolveDisclosures({
        passport: reference.identity,
        purpose,
        values: document.raw.fields ?? document.raw,
        relations: relations.raw,
      }), previous);
      outcomes.push({ reference: reference.identity, digest, relationDigest, ...commit(archive, purpose, reference.identity, digest, relationDigest, pkg) });
    } catch (error) {
      outcomes.push({ reference: reference.identity, digest, status: 'error', reason: error.message });
    }
  }
  return { purpose, context: manifest.context, ...summarizePackages(outcomes) };
}

/**
 * 落库一次字段级结果。历史收据按原文与声明摘要保留，即使之后撤销也能复查当时如何取得；
 * 当前交付始终只包含本次仍可交付的字段（内容或仅核验结论），
 * 因此失去许可的字段不会因“等待新授权”或“证明暂缺”继续留在当前包中。
 */
function commit(archive, purpose, key, digest, relationDigest, pkg) {
  const status = assessPackage(pkg);
  archive.putPackage(purpose, key, digest, relationDigest, pkg, { status });
  const deliverable = Object.keys(pkg.content).length > 0
    || Object.keys(pkg.conclusions).length > 0
    || Object.keys(pkg.proofConclusions).length > 0;
  if (deliverable) archive.deliver(purpose, key, digest, pkg);
  else archive.retract(purpose, key);
  return { status, ...pkg };
}
