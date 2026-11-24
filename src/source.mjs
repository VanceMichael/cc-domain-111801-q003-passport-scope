import { text } from './validation.mjs';

export const collectionPath = "/passports/public";
export async function browse(client) {
  const document = await client.get(collectionPath);
  const raw = document.raw;
  const context = text(raw.purpose, "purpose");
  if (!Array.isArray(raw.passports)) throw new Error('来源目录结构无效');
  const references = raw.passports.map(entry => {
    const reference = {
      identity: text(entry.id, 'id'), href: text(entry.href, 'href'), context,
    };
    // 关联资料（字段披露、证明、在途申请）的位置只接受来源目录的显式声明
    if (entry.relations !== undefined) reference.relations = text(entry.relations, 'relations');
    return reference;
  });
  if (new Set(references.map(entry => entry.identity)).size !== references.length) throw new Error('目录包含重复来源身份');
  if (new Set(references.map(entry => entry.relations).filter(Boolean)).size !== references.filter(entry => entry.relations).length) {
    throw new Error('目录包含重复关联资料位置');
  }
  return { context, references };
}
export async function retrieve(client, reference) {
  const document = await client.get(reference.href);
  if (document.raw.passport !== reference.identity) throw new Error('原文身份与目录引用不符');
  if (document.raw.purpose !== reference.context) throw new Error('原文上下文与目录不符');
  return document;
}
export async function retrieveRelations(client, reference) {
  if (!reference.relations) throw new Error('来源未声明该护照的关联资料位置');
  const document = await client.get(reference.relations);
  if (document.raw.passport !== reference.identity) throw new Error('关联资料身份与目录引用不符');
  return document;
}
