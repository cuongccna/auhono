// Mật mã cho thiết bị: suy khóa từ MASTER_SECRET, ký/kiểm chữ ký HMAC-SHA256.
// Chỉ dùng Web Crypto (có sẵn trong Workers và Node 22).

const enc = new TextEncoder();

/** Web Crypto chỉ nhận ArrayBuffer thường; kiểu Node chặt hơn Workers nên ép kiểu ở chỗ gọi. */
type Bytes = Uint8Array;

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Bytes | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out: Bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function hmacKey(raw: Bytes | string, usages: ('sign' | 'verify')[]): Promise<CryptoKey> {
  const bytes = (typeof raw === 'string' ? enc.encode(raw) : raw) as Uint8Array<ArrayBuffer>;
  return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

async function hmac(key: Bytes | string, data: string | Uint8Array): Promise<Bytes> {
  const k = await hmacKey(key, ['sign']);
  const msg = (typeof data === 'string' ? enc.encode(data) : data) as Uint8Array<ArrayBuffer>;
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, msg));
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const msg = (typeof data === 'string' ? enc.encode(data) : data) as Uint8Array<ArrayBuffer>;
  return toHex(await crypto.subtle.digest('SHA-256', msg));
}

/** Khóa bí mật 32 byte của thiết bị. Nạp vào chip lúc ráp (scripts/provision.ts). */
export function deriveDeviceKey(masterSecret: string, deviceId: string): Promise<Bytes> {
  return hmac(masterSecret, `device-key:${deviceId}`);
}

// Bảng chữ cái Crockford base32 (bỏ I, L, O, U) để in lên hộp khó nhầm.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Wi-Fi cấu hình của thiết bị (AP WPA2). Thiết bị tự suy ra từ khóa của nó bằng cùng công thức
 * (docs/PROTOCOL.md), nên lúc ráp không cần nạp thêm gì. Máy chủ suy lại để chủ quán xem khi mất tem.
 */
export async function deriveApCredentials(
  masterSecret: string,
  deviceId: string,
): Promise<{ ssid: string; password: string; qr: string }> {
  const key = await deriveDeviceKey(masterSecret, deviceId);
  const h = await hmac(key, 'ap-password:v1');
  let password = '';
  for (let i = 0; i < 10; i++) password += ALPHABET[h[i]! % 32];
  const ssid = `Auhono-${deviceId.slice(-4)}`;
  return { ssid, password, qr: `WIFI:T:WPA;S:${ssid};P:${password};H:false;;` };
}

/** Mã kích hoạt 10 ký tự (50 bit) in trong mã QR trên hộp. */
export async function deriveActivationCode(masterSecret: string, deviceId: string): Promise<string> {
  const h = await hmac(masterSecret, `activation:${deviceId}`);
  let out = '';
  for (let i = 0; i < 10; i++) out += ALPHABET[h[i]! % 32];
  return out;
}

/** Chuỗi chuẩn hóa được ký. Gắn method + path để gói của endpoint này không dùng lại ở endpoint khác. */
export async function canonicalString(p: {
  method: string;
  path: string;
  deviceId: string;
  timestamp: number;
  seq: number;
  body: Bytes;
}): Promise<string> {
  const bodyHash = await sha256Hex(p.body);
  return [p.method.toUpperCase(), p.path, p.deviceId, p.timestamp, p.seq, bodyHash].join('\n');
}

export async function signCanonical(deviceKey: Bytes, canonical: string): Promise<string> {
  return toHex(await hmac(deviceKey, canonical));
}

/** So sánh chữ ký bằng crypto.subtle.verify (thời gian không đổi, không lộ qua timing). */
export async function verifyCanonical(
  deviceKey: Bytes,
  canonical: string,
  signatureHex: string,
): Promise<boolean> {
  const sig = fromHex(signatureHex);
  if (!sig || sig.length !== 32) return false;
  const k = await hmacKey(deviceKey, ['verify']);
  return crypto.subtle.verify('HMAC', k, sig as Uint8Array<ArrayBuffer>, enc.encode(canonical));
}

/** So sánh chuỗi thời gian không đổi (cho mã kích hoạt). */
export async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const [ha, hb] = await Promise.all([hmac(key, a), hmac(key, b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i]! ^ hb[i]!;
  return diff === 0;
}
