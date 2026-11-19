import { text } from './validation.mjs';

export const collectionPath = "/passports/public";
export async function browse(client) {
  const document = await client.get(collectionPath);
  const raw = document.raw;
  const context = text(raw.purpose, "purpose");
  if (!Array.isArray(raw.passports)) throw new Error('来源目录结构无效');
  const references = raw.passports.map(entry => ({
    identity: text(entry.id, 'id'), href: text(entry.href, 'href'), context,
    relations: entry.relations === undefined ? undefined : text(entry.relations, 'relations'),
    purposes: entry.purposes === undefined ? undefined : entry.purposes.map(item => text(item, 'purposes')),
  }));
  if (new Set(references.map(entry => entry.identity)).size !== references.length) throw new Error('目录包含重复来源身份');
  return { context, references };
}
export async function retrieve(client, reference) {
  const document = await client.get(reference.href);
  if (document.raw.passport !== reference.identity) throw new Error('原文身份与目录引用不符');
  if (document.raw.purpose !== reference.context) throw new Error('原文上下文与目录不符');
  return document;
}
/**
 * 关联资料的可选位置。省略时按当前示例的约定推导；显式声明的位置优先。
 * 这里只读取来源已发布的声明，不构造其他用途或扩大访问范围的地址。
 */
export function relationPath(reference) {
  return reference.relations ?? reference.href.replace(/\/records\//, '/relations/');
}
export async function retrieveRelations(client, reference) {
  const document = await client.get(relationPath(reference));
  if (document.raw.passport !== undefined && document.raw.passport !== reference.identity) throw new Error('关联资料身份与目录引用不符');
  return document;
}
