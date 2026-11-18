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
