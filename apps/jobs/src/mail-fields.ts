import type { Address } from 'postal-mime';

export function cleanMailField(value: string, limit: number): string {
  return value.replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, limit);
}

export function formatMailAddresses(addresses: Address[] | undefined): string {
  return addresses?.map(formatMailAddress).filter(Boolean).join(', ') ?? '';
}

export function formatMailAddress(address: Address): string {
  if ('group' in address && address.group !== undefined) {
    return `${address.name}: ${address.group.map(formatMailAddress).join(', ')};`;
  }
  const name = cleanMailField(address.name, 512);
  const mailbox = cleanMailField(address.address, 320);
  return name === '' ? mailbox : mailbox === '' ? name : `${name} <${mailbox}>`;
}

export function textFromHtml(value: string): string {
  return value.replace(/<style[\s\S]*?<\/style>/giu, ' ')
    .replace(/<script[\s\S]*?<\/script>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ');
}
