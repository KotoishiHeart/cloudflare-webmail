export async function sha256Hex(value: ArrayBuffer | ArrayBufferView): Promise<string> {
  const source = value instanceof ArrayBuffer
    ? value
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer;
  return hex(await crypto.subtle.digest('SHA-256', source));
}

export function hex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
