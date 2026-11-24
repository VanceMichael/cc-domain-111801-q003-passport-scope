import { text } from './validation.mjs';

// 字段处置方式：明确区分字段内容、仅核验结论与缺失的授权依据
export const TREATMENTS = Object.freeze({
  DELIVERED: 'delivered',              // 已获批 deliver，字段内容可进入当前用途的采集包
  VERIFIED_ONLY: 'verified-only',      // 证明仅允许核验，只保留核验结论，不交付字段内容
  VERIFICATION_FAILED: 'verification-failed', // 实际取得的证明与来源声明不符
  WITHHELD_DERIVED: 'withheld-derived', // 派生字段依赖的来源字段失去有效结论
  GRANT_WITHDRAWN: 'grant-withdrawn',  // 来源已收缩/隐藏许可，当前包不得继续交付
  PENDING_GRANT: 'pending-grant',      // 新授权申请尚未通过，不等于字段不存在
  PROOF_UNAVAILABLE: 'proof-unavailable', // 证明暂时取不到，不等于核验失败
});

const MODES = new Set(['deliver', 'verify-only']);
const REQUEST_STATUSES = new Set(['pending', 'approved', 'rejected']);

// 解释来源发布的字段披露关系：用途许可、证明模式、派生依赖与在途申请
export function interpretRelations(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('披露关系不是对象');
  const passport = text(raw.passport, 'passport');
  if (!Array.isArray(raw.disclosures)) throw new Error('披露列表结构无效');
  const proofs = new Map();
  for (const item of raw.proofs ?? []) {
    if (!item || typeof item !== 'object') throw new Error('证明条目结构无效');
    const id = text(item.id, 'proof.id');
    const mode = text(item.mode, 'proof.mode');
    if (!MODES.has(mode)) throw new Error('证明模式无效：' + id);
    const href = text(item.href, 'proof.href');
    const digest = item.digest === undefined ? null : text(item.digest, 'proof.digest');
    if (digest !== null && !/^[a-f0-9]{64}$/.test(digest)) throw new Error('证明摘要格式无效：' + id);
    if (proofs.has(id)) throw new Error('证明身份重复：' + id);
    proofs.set(id, { id, mode, href, digest });
  }
  const disclosures = [];
  const disclosureKeys = new Set();
  for (const item of raw.disclosures) {
    if (!item || typeof item !== 'object') throw new Error('披露条目结构无效');
    const field = text(item.field, 'disclosure.field');
    const purpose = text(item.purpose, 'disclosure.purpose');
    const mode = text(item.mode, 'disclosure.mode');
    if (!MODES.has(mode)) throw new Error('披露模式无效：' + field);
    const proofId = text(item.proof, 'disclosure.proof');
    const proof = proofs.get(proofId);
    if (!proof) throw new Error('披露引用了未声明的证明：' + proofId);
    if (proof.mode !== mode) throw new Error('披露模式与证明模式不一致：' + field);
    const key = field + ' ' + purpose;
    if (disclosureKeys.has(key)) throw new Error('同一用途下字段披露重复：' + key);
    disclosureKeys.add(key);
    const visible = item.visible === undefined ? true : item.visible === true;
    let derivesFrom = null;
    if (item.derivesFrom !== undefined) {
      if (!Array.isArray(item.derivesFrom) || item.derivesFrom.some(value => typeof value !== 'string' || !value.trim())) {
        throw new Error('派生依赖结构无效：' + field);
      }
      derivesFrom = item.derivesFrom.map(value => value.trim());
    }
    disclosures.push({ field, purpose, mode, proof: proofId, visible, derivesFrom });
  }
  const requests = [];
  const requestKeys = new Set();
  for (const item of raw.requests ?? []) {
    if (!item || typeof item !== 'object') throw new Error('授权申请结构无效');
    const field = text(item.field, 'request.field');
    const purpose = text(item.purpose, 'request.purpose');
    const status = text(item.status, 'request.status');
    if (!REQUEST_STATUSES.has(status)) throw new Error('授权申请状态无效：' + status);
    const key = field + ' ' + purpose;
    if (requestKeys.has(key)) throw new Error('同一用途下授权申请重复：' + key);
    requestKeys.add(key);
    requests.push({ field, purpose, status });
  }
  return { passport, disclosures, proofs, requests };
}

// 解释可交付证明对应的字段原文；verify-only 资料不会经过这里进入交付通道
export function interpretFieldDocument(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('字段资料不是对象');
  const passport = text(raw.passport, 'field.passport');
  const field = text(raw.field, 'field.name');
  const proof = text(raw.proof, 'field.proof');
  const value = raw.value;
  const validValue = typeof value === 'string' && value.trim()
    ? value
    : Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item.trim())
      ? value.slice()
      : null;
  if (validValue === null) throw new Error('字段内容缺失或无效：' + field);
  return { passport, field, proof, value: validValue };
}

// 纯领域评估：依据当前披露、实际观察结果与历史收据，给出每个字段的处置结论
// observations: Map(proofId -> { ok, reason?, digest?, raw? })
// previous: 该用途下历史字段收据
export function evaluateFields(relations, observations, previous, purpose) {
  const decisions = [];
  const usable = new Set(); // 当前用途下拥有可靠结论（交付或核验）的字段
  const mine = relations.disclosures.filter(entry => entry.purpose === purpose);

  for (const disclosure of mine) {
    const base = { field: disclosure.field, purpose, mode: disclosure.mode, proof: disclosure.proof };
    const prior = previous.find(item => item.passport === relations.passport && item.field === disclosure.field);
    if (disclosure.visible === false) {
      decisions.push({
        ...base,
        treatment: TREATMENTS.GRANT_WITHDRAWN,
        previouslyDelivered: prior?.decision?.treatment === TREATMENTS.DELIVERED,
        reason: '来源已将该字段变更为隐藏，当前用途的采集包不得继续交付',
      });
      continue;
    }
    const observation = observations.get(disclosure.proof);
    if (!observation || observation.ok !== true) {
      // 证明暂时取不到：可能是 403/404/503 或网络问题，不能写成核验失败
      decisions.push({
        ...base,
        treatment: TREATMENTS.PROOF_UNAVAILABLE,
        temporary: true,
        reason: observation?.reason ? '证明暂时不可取：' + observation.reason : '证明资料尚未取得',
      });
      continue;
    }
    const proof = relations.proofs.get(disclosure.proof);
    if (proof.digest !== null && proof.digest !== observation.digest) {
      decisions.push({
        ...base,
        treatment: TREATMENTS.VERIFICATION_FAILED,
        declaredDigest: proof.digest,
        observedDigest: observation.digest,
        reason: '观察到的证明摘要与来源声明不一致',
      });
      continue;
    }
    if (disclosure.mode === 'verify-only') {
      decisions.push({
        ...base,
        treatment: TREATMENTS.VERIFIED_ONLY,
        digest: observation.digest,
        reason: '证明仅允许核验、不得交付，只保留核验结论',
      });
      usable.add(disclosure.field);
      continue;
    }
    const delivered = {
      ...base,
      treatment: TREATMENTS.DELIVERED,
      digest: observation.digest,
    };
    if (observation.raw?.value !== undefined) delivered.value = observation.raw.value;
    decisions.push(delivered);
    usable.add(disclosure.field);
  }

  // 派生字段第二轮：只要任一来源字段在当前用途下失去可靠结论，派生内容一并撤出当前包
  for (const disclosure of mine) {
    if (!disclosure.derivesFrom) continue;
    const decision = decisions.find(item => item.field === disclosure.field);
    if (!decision || decision.treatment !== TREATMENTS.DELIVERED) continue;
    const blockedSources = disclosure.derivesFrom.filter(source => !usable.has(source));
    if (blockedSources.length > 0) {
      decision.treatment = TREATMENTS.WITHHELD_DERIVED;
      delete decision.value;
      decision.basedOn = disclosure.derivesFrom;
      decision.blockedSources = blockedSources;
      decision.reason = '派生字段依赖的来源字段当前缺少可交付或可核验结论，连同派生内容一起撤出';
      usable.delete(disclosure.field);
    }
  }

  // 在途授权申请：申请未通过不能当成字段不存在，也不能伪造内容
  for (const request of relations.requests) {
    if (request.purpose !== purpose || request.status !== 'pending') continue;
    const granted = mine.some(disclosure => disclosure.field === request.field && disclosure.visible !== false);
    if (granted) continue;
    decisions.push({
      field: request.field,
      purpose,
      treatment: TREATMENTS.PENDING_GRANT,
      requestStatus: 'pending',
      reason: '新授权申请尚未通过，字段暂缺授权依据，不视为字段不存在',
    });
  }
  return decisions;
}

export function isMissingBasis(treatment) {
  return treatment === TREATMENTS.PENDING_GRANT
    || treatment === TREATMENTS.GRANT_WITHDRAWN
    || treatment === TREATMENTS.PROOF_UNAVAILABLE
    || treatment === TREATMENTS.WITHHELD_DERIVED;
}
