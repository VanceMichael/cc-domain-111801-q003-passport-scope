import { browse, retrieve, retrieveRelations } from './source.mjs';
import { interpret } from './interpret.mjs';
import { assess, summarize } from './receiving.mjs';
import {
  interpretRelations, interpretFieldDocument, evaluateFields, isMissingBasis, TREATMENTS,
} from './disclosures.mjs';

export async function preview(client) {
  const manifest = await browse(client);
  const entries = [];
  for (const ref of manifest.references) {
    const document = await retrieve(client, ref);
    entries.push(interpret(document.raw));
  }
  return { context: manifest.context, entries };
}

// 公开摘要范围：保留原有公开收件语义
async function collectPublic(client, archive, scope, operator, references) {
  const outcomes = [];
  for (const reference of references) {
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
  return summarize(outcomes);
}

function buildFieldReport(decisions) {
  const delivered = [];
  const verifications = [];
  const missingBasis = [];
  for (const decision of decisions) {
    if (decision.treatment === TREATMENTS.DELIVERED) delivered.push(decision);
    else if (decision.treatment === TREATMENTS.VERIFIED_ONLY
      || decision.treatment === TREATMENTS.VERIFICATION_FAILED) verifications.push(decision);
    else if (isMissingBasis(decision.treatment)) missingBasis.push(decision);
  }
  return { delivered, verifications, missingBasis };
}

// 按已获批用途接收字段级资料：只消费来源已授予的权限，不尝试扩大访问范围
async function collectByPurpose(client, archive, purpose, references) {
  const passportResults = [];
  const treatmentCounts = {};
  for (const reference of references) {
    const passport = reference.identity;
    // 公开摘要原文始终作为当时领取证据保存，但不会以全量原文形式进入用途采集包
    let record;
    try {
      const recordDocument = await retrieve(client, reference);
      await archive.preserve(recordDocument);
      record = interpret(recordDocument.raw);
    } catch (error) {
      passportResults.push({ reference: passport, status: 'error', reason: error.message });
      treatmentCounts.error = (treatmentCounts.error ?? 0) + 1;
      continue;
    }

    let relations;
    let relationDigest;
    let observedAt;
    try {
      const relationsDocument = await retrieveRelations(client, reference);
      relationDigest = await archive.preserve(relationsDocument);
      observedAt = relationsDocument.observedAt;
      relations = interpretRelations(relationsDocument.raw);
    } catch (error) {
      // 关联资料暂时取不到：不虚报删除、不伪造核验结论
      passportResults.push({
        reference: passport,
        status: 'error',
        reason: '披露关系暂时不可取：' + error.message,
      });
      treatmentCounts.error = (treatmentCounts.error ?? 0) + 1;
      continue;
    }

    const observations = new Map();
    for (const disclosure of relations.disclosures.filter(item => item.purpose === purpose && item.visible !== false)) {
      const proof = relations.proofs.get(disclosure.proof);
      if (observations.get(proof.id)?.ok === true) continue;
      try {
        const proofDocument = await client.get(proof.href);
        const digest = await archive.preserve(proofDocument);
        let raw = null;
        if (proof.mode === 'deliver') {
          raw = interpretFieldDocument(proofDocument.raw);
          if (raw.passport !== passport || raw.proof !== proof.id) throw new Error('字段资料身份与证明声明不符');
        }
        observations.set(proof.id, { ok: true, digest, raw });
      } catch (error) {
        // 403/404/503/超时都只是暂时不可取，不能写成核验失败
        observations.set(proof.id, { ok: false, reason: error.message });
      }
    }

    const previous = archive.fieldReceipts(purpose).filter(item => item.passport === passport);
    const decisions = evaluateFields(relations, observations, previous, purpose);
    for (const decision of decisions) {
      const proofDigest = decision.digest ?? null;
      archive.putFieldReceipt(purpose, passport, decision.field, decision, {
        digest: proofDigest,
        relationDigest,
        observedAt,
      });
      treatmentCounts[decision.treatment] = (treatmentCounts[decision.treatment] ?? 0) + 1;
    }    passportResults.push({
      reference: passport,
      status: 'processed',
      model: record.model,
      relationDigest,
      ...buildFieldReport(decisions),
    });
  }

  const failures = passportResults.filter(item => item.status === 'error').length;
  const verificationFailures = treatmentCounts[TREATMENTS.VERIFICATION_FAILED] ?? 0;
  const unavailable = treatmentCounts[TREATMENTS.PROOF_UNAVAILABLE] ?? 0;
  // pending/withdrawn 是正常的授权状态，不算流程失败；传输错误、核验失败、证明暂不可取才阻止宣告完成
  const complete = passportResults.length > 0 && failures === 0 && verificationFailures === 0 && unavailable === 0;
  return {
    purpose,
    complete,
    counts: treatmentCounts,
    passports: passportResults,
    currentPackage: archive.currentPackage(purpose),
  };
}

export async function collect(client, archive, scope, operator) {
  const manifest = await browse(client);
  if (scope === manifest.context) {
    return { context: manifest.context, ...await collectPublic(client, archive, scope, operator, manifest.references) };
  }
  return { context: manifest.context, ...await collectByPurpose(client, archive, scope, manifest.references) };
}
