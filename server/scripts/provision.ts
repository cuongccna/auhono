// Sinh thiết bị hàng loạt lúc ráp máy.
//
//   MASTER_SECRET=... node scripts/provision.ts --start 1 --count 8 [--out out]
//
// Ghi ra thư mục --out (mặc định ./out, đã .gitignore vì chứa KHÓA BÍ MẬT):
//   devices.sql  - INSERT vào D1:  wrangler d1 execute auhono --remote --file out/devices.sql
//   devices.csv  - id, khóa (hex, nạp vào chip), mã kích hoạt, nội dung mã QR dán lên hộp
// MASTER_SECRET đọc từ biến môi trường (không nhận qua tham số để khỏi lọt vào lịch sử shell).
import { mkdirSync, writeFileSync } from 'node:fs';
import { deriveActivationCode, deriveDeviceKey, toHex } from '../src/crypto.ts';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const master = process.env.MASTER_SECRET;
if (!master || master.length < 32) {
  console.error('Cần biến môi trường MASTER_SECRET (>= 32 ký tự). Sinh bằng: openssl rand -hex 32');
  process.exit(1);
}
const start = Number(arg('start', '1'));
const count = Number(arg('count', '1'));
const out = arg('out', 'out');
if (!Number.isInteger(start) || start < 1 || !Number.isInteger(count) || count < 1 || count > 1000) {
  console.error('--start >= 1, 1 <= --count <= 1000');
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const sql: string[] = [];
const csv = ['device_id,device_key_hex,activation_code,qr_payload'];
for (let n = start; n < start + count; n++) {
  const id = `AUH-${String(n).padStart(6, '0')}`;
  const key = toHex(await deriveDeviceKey(master, id));
  const code = await deriveActivationCode(master, id);
  sql.push(`INSERT OR IGNORE INTO devices (id, created_at) VALUES ('${id}', ${now});`);
  csv.push(`${id},${key},${code},auhono://claim?d=${id}&c=${code}`);
}

mkdirSync(out, { recursive: true });
writeFileSync(`${out}/devices.sql`, sql.join('\n') + '\n', { mode: 0o600 });
writeFileSync(`${out}/devices.csv`, csv.join('\n') + '\n', { mode: 0o600 });
console.log(`Đã tạo ${count} thiết bị (AUH-${String(start).padStart(6, '0')}…) trong ${out}/. Giữ devices.csv an toàn, đừng commit.`);
