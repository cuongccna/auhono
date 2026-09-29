// Vector chuẩn cho giao thức chữ ký. Đã đối chiếu độc lập bằng openssl. Firmware phải cho
// cùng kết quả (docs/PROTOCOL.md) — đổi giá trị ở đây là phá vỡ tương thích với thiết bị đã giao.
import { expect, it } from 'vitest';
import { canonicalString, deriveActivationCode, deriveApCredentials, deriveDeviceKey, sha256Hex, signCanonical, toHex } from '../src/crypto.ts';

it('vector chuẩn', async () => {
  const master = 'test-master-secret-do-not-use-in-prod';
  const body = new TextEncoder().encode('{"readings":[{"t":1800000000,"c":-19.5}]}');
  const key = await deriveDeviceKey(master, 'AUH-000001');
  const canon = await canonicalString({ method: 'POST', path: '/v1/readings', deviceId: 'AUH-000001', timestamp: 1800000000, seq: 7, body });

  expect(toHex(key)).toBe('41bc43e33ceb8fd260f6888bcf8b89858310b99545a24ac3a6a76bb1b7b8a507');
  expect(await sha256Hex(body)).toBe('76d37a0d15295407d0cf6b872b02a1a239a43d23d8ce8bcfd65be46622156899');
  expect(canon).toBe('POST\n/v1/readings\nAUH-000001\n1800000000\n7\n76d37a0d15295407d0cf6b872b02a1a239a43d23d8ce8bcfd65be46622156899');
  expect(await signCanonical(key, canon)).toBe('8c2bca443f59548fb5ac50fa912d6e58bff435fdc5a563b46767e6699fcdb12a');
  expect(await deriveActivationCode(master, 'AUH-000001')).toBe('YVYMMS5D87');
});

it('vector Wi-Fi cấu hình (AP WPA2), đã đối chiếu bằng openssl', async () => {
  const ap = await deriveApCredentials('test-master-secret-do-not-use-in-prod', 'AUH-000001');
  expect(ap).toEqual({
    ssid: 'Auhono-0001',
    password: 'XP1CZHP3Z0',
    qr: 'WIFI:T:WPA;S:Auhono-0001;P:XP1CZHP3Z0;H:false;;',
  });
  // WPA2-PSK cần 8–63 ký tự, chỉ chữ số/chữ hoa Crockford (không ký tự đặc biệt cần escape trong mã QR Wi-Fi).
  expect(ap.password).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
});
