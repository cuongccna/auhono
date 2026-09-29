// Rà soát tĩnh mã nguồn ứng dụng (không tính file test): không có đường nào để rò token/dữ liệu người dùng
// hoặc chạy nội dung do người dùng/QR/server cung cấp.
import { describe, expect, it } from 'vitest';

const all = import.meta.glob('./**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
const source = Object.entries(all)
  .filter(([path]) => !/\.test\.tsx?$/.test(path))
  .map(([path, text]) => [path, stripComments(text)] as const);

const offenders = (re: RegExp) => source.filter(([, text]) => re.test(text)).map(([path]) => path);

describe('rà soát mã nguồn (bảo mật)', () => {
  it('có mã nguồn để rà (tránh test rỗng vô nghĩa)', () => {
    expect(source.length).toBeGreaterThan(15);
  });

  it.each([
    ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/],
    ['innerHTML/outerHTML/insertAdjacentHTML/document.write', /\b(innerHTML|outerHTML|insertAdjacentHTML)\b|document\.write/],
    ['eval / new Function / setTimeout(chuỗi)', /\beval\s*\(|new\s+Function\s*\(|set(Timeout|Interval)\(\s*['"`]/],
    ['console.*', /\bconsole\s*\./],
    ['localStorage / sessionStorage / indexedDB / cookie', /\b(localStorage|sessionStorage|indexedDB)\b|document\.cookie/],
    ['mở/điều hướng URL tự do', /window\.open|location\.(href|assign|replace)\s*[=(]|openWebview|openOutApp|openMiniApp|openShareSheet/],
    ['sendBeacon / XMLHttpRequest / WebSocket (chỉ được dùng fetch của api-client)', /sendBeacon|XMLHttpRequest|new\s+WebSocket/],
  ])('không dùng %s', (_name, re) => {
    expect(offenders(re)).toEqual([]);
  });

  it('chỉ api-client.ts gọi fetch', () => {
    expect(offenders(/\bfetch\s*\(/)).toEqual(['./api-client.ts']);
  });

  it('token chỉ đi qua sdk.ts, api.ts, api-client.ts và hộp báo lỗi (kiểm tra lại quyền)', () => {
    const users = offenders(/\bgetToken\b|getAccessToken/).sort();
    expect(users).toEqual(['./api-client.ts', './api.ts', './components/error-box.tsx', './sdk.ts']);
  });

  it('token không bao giờ được ghép vào URL hay ghi vào state: chỉ nằm trong header Authorization', () => {
    const client = source.find(([p]) => p === './api-client.ts')![1];
    expect(client).toMatch(/Authorization: `Bearer \$\{token\}`/);
    expect(client.match(/\$\{token\}/g)).toHaveLength(1); // đúng một chỗ dùng: header
    expect(client).not.toMatch(/access_token/);
    expect(client).toContain('baseUrl + path'); // URL chỉ ghép từ địa chỉ gốc + đường dẫn cố định
  });

  it('không có bí mật của zmp-cli / server trong mã nguồn ứng dụng, và chỉ đọc một biến VITE_', () => {
    expect(offenders(/ZMP_TOKEN|APP_SECRET|MASTER_SECRET|ZALO_APP_SECRET|DEVICE_KEY/)).toEqual([]);
    const vars = new Set(source.flatMap(([, t]) => [...t.matchAll(/VITE_[A-Z_]+/g)].map((m) => m[0])));
    expect([...vars]).toEqual(['VITE_API_BASE']);
  });

  it('chỉ import những hàm zmp-sdk đã được xem xét', () => {
    const allowed = new Set(['authorize', 'checkZaloCameraPermission', 'getAccessToken', 'getSystemInfo', 'openPermissionSetting', 'requestCameraPermission', 'scanQRCode']);
    const imports = source.flatMap(([, t]) => [...t.matchAll(/import\s*\{([^}]*)\}\s*from\s*'zmp-sdk'/g)].flatMap((m) => m[1]!.split(',').map((x) => x.trim()).filter(Boolean)));
    expect(imports.length).toBeGreaterThan(0);
    for (const name of imports) expect(allowed.has(name), name).toBe(true);
  });
});

describe('điều hướng nội bộ', () => {
  it('mọi navigate(`...${x}...`) chỉ nhúng giá trị đã encodeURIComponent (chặn chuyển hướng lạ qua mã thiết bị có "\\" hay "//")', () => {
    const bad: string[] = [];
    for (const [path, text] of source) {
      for (const m of text.matchAll(/navigate\(\s*`([^`]*)`/g)) {
        for (const expr of m[1]!.matchAll(/\$\{([^}]*)\}/g)) {
          if (!/^(enc|encodeURIComponent\()/.test(expr[1]!.trim())) bad.push(`${path}: ${expr[1]}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
