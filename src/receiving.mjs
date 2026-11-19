export function assess(record, previous, scope) {
  if (record.purpose !== scope || !record.public) return { status: 'outside', reason: '用途与公开收件范围不一致' };
           const existing = previous.find(item => item.passport === record.passport && item.model !== record.model);
           if (existing) return { status: 'conflict', reason: '同一护照指向不同型号' };
           return { status: 'accepted', key: record.passport, facts: { passport: record.passport, model: record.model, purpose: record.purpose, capacityWh: record.capacityWh } };
}

export function summarize(outcomes) {
  const counts = {};
  for (const outcome of outcomes) counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
  return { complete: outcomes.length > 0 && outcomes.every(outcome => outcome.status === 'accepted'), counts, outcomes };
}

const settled = new Set(['accepted', 'conclusion']);

/**
 * 字段级接收结果：内容、仅核验结论与仍缺授权依据分别计数，
 * 不能用“没有字段”掩盖待授权，也不能把暂时不可取的证明写成核验失败。
 */
export function assessPackage(pkg) {
  const contentFields = Object.keys(pkg.content);
  const conclusionFields = Object.keys(pkg.conclusions);
  const hasContent = contentFields.length > 0;
  const hasConclusion = conclusionFields.length > 0 || Object.keys(pkg.proofConclusions).length > 0;
  if (pkg.pending.length > 0) return 'pending';
  if (hasContent) return 'accepted';
  if (hasConclusion) return 'conclusion';
  if (pkg.withheld.length > 0) return 'withheld';
  return 'empty';
}

export function summarizePackages(outcomes) {
  const counts = {};
  for (const outcome of outcomes) counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
  return {
    complete: outcomes.length > 0 && outcomes.every(outcome => settled.has(outcome.status)),
    counts,
    outcomes,
  };
}
