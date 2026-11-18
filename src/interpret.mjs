import { text, decimal } from './validation.mjs';

export function interpret(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('来源记录不是对象');
  if (raw.public !== true) throw new Error('非公开摘要不能按公开资料解释');
           const capacityWh = decimal(raw.capacityWh, 'capacityWh');
           if (capacityWh <= 0) throw new Error('额定容量无效');
           return { passport: text(raw.passport, 'passport'), purpose: text(raw.purpose, 'purpose'), model: text(raw.model, 'model'), manufacturer: text(raw.manufacturer, 'manufacturer'), capacityWh, public: true };
}
