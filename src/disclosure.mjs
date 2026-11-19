import { text } from './validation.mjs';

const modes = new Set(['content', 'verify-only']);
const pendingAuthorization = new Set(['pending', 'requested', 'not-approved', 'unapproved']);

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(name + '不是对象');
  return value;
}

function stringList(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(name + '结构无效');
  return value.map(item => text(item, name));
}

function pendingAuthorizationFor(entry) {
  if (entry.approved === false || entry.authorizationApproved === false) return true;
  return typeof entry.authorization === 'string' && pendingAuthorization.has(entry.authorization);
}

/**
 * 解释来源发布的字段披露声明。这里只解释声明本身，不读取任何原文值，
 * 因此调用方无法借解释过程取得未获交付许可的字段。
 */
export function interpretRelations(raw) {
  const relation = object(raw, '关联资料');
  const admissionList = relation.disclosures ?? [];
  const proofList = relation.proofs ?? [];
  if (!Array.isArray(admissionList)) throw new Error('关联资料 disclosures 结构无效');
  if (!Array.isArray(proofList)) throw new Error('关联资料 proofs 结构无效');

  const proofs = proofList.map(entry => {
    const proof = object(entry, '证明条目');
    const mode = proof.mode === undefined ? 'content' : proof.mode;
    if (!modes.has(mode)) throw new Error('证明模式无效：' + String(proof.id));
    return {
      id: text(proof.id, 'proofs[].id'),
      mode,
      available: proof.available !== false && proof.status !== 'unavailable',
      verified: proof.verified !== false && proof.status !== 'failed',
      conclusion: proof.conclusion,
      dependsOn: stringList(proof.dependsOn, 'proofs[].dependsOn'),
    };
  });
  if (new Set(proofs.map(proof => proof.id)).size !== proofs.length) throw new Error('证明身份重复');

  const disclosures = admissionList.map(entry => {
    const disclosure = object(entry, '披露条目');
    return {
      field: text(disclosure.field, 'disclosures[].field'),
      purpose: text(disclosure.purpose, 'disclosures[].purpose'),
      proof: disclosure.proof === undefined ? undefined : text(disclosure.proof, 'disclosures[].proof'),
      derivedFrom: stringList(disclosure.derivedFrom, 'disclosures[].derivedFrom'),
      pendingAuthorization: pendingAuthorizationFor(disclosure),
      hidden: disclosure.hidden === true || disclosure.visible === false,
      revoked: disclosure.revoked === true,
    };
  });

  const seen = new Set();
  for (const disclosure of disclosures) {
    const key = disclosure.purpose + '\u0000' + disclosure.field;
    if (seen.has(key)) throw new Error('同一用途下字段披露重复：' + disclosure.field);
    seen.add(key);
  }

  return { disclosures, proofs };
}

function readField(values, field) {
  if (!Object.hasOwn(values, field)) return undefined;
  const value = values[field];
  return value === undefined || value === null ? undefined : value;
}

/**
 * 按已获批用途形成字段级接收包。
 *
 * content         可交付的字段内容
 * conclusions     只允许核验的资料所得出的结论，不含原始内容
 * proofConclusions 依赖链上只允许核验的证明所得出的结论
 * pending         仍缺少授权或证明依据的字段（不是字段不存在，也不是核验失败）
 * withheld        已失去交付许可的字段，含受其派生影响的字段
 * evidence        每个字段当时依据的证明与处理结果
 */
export function resolveDisclosures({ passport, purpose, values = {}, relations } = {}) {
  const name = text(purpose, 'purpose');
  const owner = text(passport, 'passport');
  const source = object(values ?? {}, '字段资料');
  const { disclosures, proofs } = interpretRelations(relations ?? { disclosures: [], proofs: [] });
  const proofById = new Map(proofs.map(proof => [proof.id, proof]));
  const relevant = disclosures.filter(disclosure => disclosure.purpose === name);

  const content = {};
  const conclusions = {};
  const proofConclusions = {};
  const pending = [];
  const withheld = [];
  const states = new Map();

  const withhold = (disclosure, reason, via) => {
    states.set(disclosure.field, 'withheld');
    withheld.push({ field: disclosure.field, reason, ...(via ? { via } : {}) });
  };
  const defer = (disclosure, reason, extra = {}) => {
    states.set(disclosure.field, 'pending');
    pending.push({ field: disclosure.field, reason, ...extra });
  };

  for (const disclosure of relevant) {
    if (disclosure.revoked) { withhold(disclosure, 'authorization-revoked'); continue; }
    if (disclosure.hidden) { withhold(disclosure, 'source-hidden'); continue; }
    // 新申请尚未通过表示“依据仍缺”，不能当成字段不存在，也不能写成核验失败。
    if (disclosure.pendingAuthorization) { defer(disclosure, 'authorization-pending', { proof: disclosure.proof }); continue; }

    const proof = disclosure.proof === undefined ? undefined : proofById.get(disclosure.proof);
    if (!proof) { defer(disclosure, 'proof-unavailable', { proof: disclosure.proof }); continue; }
    // 暂时取不到证明只影响当前可交付性，不改变字段存在性，也不是核验失败。
    if (!proof.available) { defer(disclosure, 'proof-unavailable', { proof: proof.id }); continue; }

    const unavailableBasis = proof.dependsOn.find(id => {
      const dependency = proofById.get(id);
      return !dependency || !dependency.available;
    });
    if (unavailableBasis) { defer(disclosure, 'proof-basis-unavailable', { proof: unavailableBasis }); continue; }

    for (const id of proof.dependsOn) {
      const dependency = proofById.get(id);
      if (dependency?.mode === 'verify-only') {
        // 只允许核验的依赖资料只贡献结论，不能把其原始内容带入接收包。
        proofConclusions[id] = dependency.conclusion === undefined ? { verified: true } : dependency.conclusion;
      }
    }

    if (proof.mode === 'verify-only') {
      conclusions[disclosure.field] = proof.conclusion === undefined ? { verified: true } : proof.conclusion;
      states.set(disclosure.field, 'conclusion');
      continue;
    }
    if (!proof.verified) {
      conclusions[disclosure.field] = proof.conclusion === undefined ? { verified: false } : proof.conclusion;
      states.set(disclosure.field, 'conclusion');
      continue;
    }

    const value = readField(source, disclosure.field);
    if (value === undefined) { defer(disclosure, 'field-value-unavailable'); continue; }
    content[disclosure.field] = value;
    states.set(disclosure.field, 'content');
  }

  // 派生字段只有在全部来源字段都可交付时才可作为内容交付；循环直到传递闭包稳定。
  let changed = true;
  while (changed) {
    changed = false;
    for (const disclosure of relevant) {
      if (disclosure.derivedFrom.length === 0) continue;
      if (states.get(disclosure.field) !== 'content') continue;
      let blocker;
      for (const field of disclosure.derivedFrom) {
        const state = states.get(field);
        if (state !== 'content') { blocker = { field, state }; break; }
      }
      if (!blocker) continue;
      delete content[disclosure.field];
      withhold(disclosure, 'derived-from-' + (blocker.state ?? 'undisclosed'), blocker.field);
      changed = true;
    }
  }

  const evidence = relevant.map(disclosure => {
    const state = states.get(disclosure.field);
    const proof = disclosure.proof === undefined ? undefined : proofById.get(disclosure.proof);
    return {
      field: disclosure.field,
      proof: disclosure.proof,
      mode: proof?.mode,
      derivedFrom: disclosure.derivedFrom.length > 0 ? [...disclosure.derivedFrom] : undefined,
      outcome: state ?? 'not-delivered',
      delivered: state === 'content',
    };
  });
  for (const id of Object.keys(proofConclusions).sort()) {
    evidence.push({ proof: id, mode: 'verify-only', outcome: 'conclusion', delivered: false });
  }

  return finalize({
    passport: owner,
    purpose: name,
    content,
    conclusions,
    proofConclusions,
    pending,
    withheld,
    evidence,
  });
}

function finalize(pkg) {
  const byField = (left, right) => left.field.localeCompare(right.field);
  return {
    ...pkg,
    pending: [...pkg.pending].sort(byField),
    withheld: [...pkg.withheld].sort(byField),
  };
}

/**
 * 与同一用途上一次的当前交付比较。若某字段当时可交付（内容或仅核验结论），
 * 本次已不在任何披露状态中，说明来源已不再授予该用途，当前包必须移除它；
 * 旧原文与旧收据仍作为证据保留。
 */
export function reconcilePrevious(pkg, previous) {
  const prior = previous ?? {};
  const previousFields = new Set([
    ...Object.keys(prior.content ?? {}),
    ...Object.keys(prior.conclusions ?? {}),
  ]);
  const known = new Set([
    ...Object.keys(pkg.content),
    ...Object.keys(pkg.conclusions),
    ...pkg.pending.map(item => item.field),
    ...pkg.withheld.map(item => item.field),
  ]);
  for (const field of [...previousFields].sort()) {
    if (!known.has(field)) {
      pkg.withheld.push({ field, reason: 'no-longer-disclosed' });
      known.add(field);
    }
  }
  return finalize(pkg);
}

// 便于调用方按业务词汇引用同一实现。
export const interpretDisclosures = interpretRelations;
export const buildPackage = resolveDisclosures;
