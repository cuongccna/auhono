// Kiểm tra nhanh việc vẽ: dùng renderToStaticMarkup nên không cần DOM/jsdom.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TempChart } from './temp-chart.tsx';

const NOW = Date.UTC(2026, 8, 29, 5, 0) / 1000;
const p = (t: number, avg: number) => ({ t, avg, min: avg - 0.5, max: avg + 0.5 });

describe('TempChart', () => {
  it('vẽ svg có nhãn truy cập, đường, dải min-max, dải ngưỡng và tóm tắt bằng chữ', () => {
    const points = Array.from({ length: 10 }, (_, i) => p(NOW - 3000 + i * 300, -20));
    const html = renderToStaticMarkup(<TempChart points={points} minC={-40} maxC={-18} nowSec={NOW} />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-labelledby');
    expect(html).toContain('<title');
    expect(html).toContain('class="line"');
    expect(html).toContain('class="envelope"');
    expect(html).toContain('class="band"');
    expect(html).toContain('Trong 24 giờ qua');
    expect(html).toContain('giờ Việt Nam');
  });

  it('ngắt đường khi có khoảng mất kết nối: 2 path đường + vùng gap', () => {
    const points = [p(NOW - 7200, -20), p(NOW - 6900, -20), p(NOW - 3600, -20), p(NOW - 3300, -20)];
    const html = renderToStaticMarkup(<TempChart points={points} minC={-40} maxC={-18} nowSec={NOW} />);
    expect((html.match(/class="line"/g) ?? []).length).toBe(2);
    expect(html).toContain('class="gap"');
  });

  it('không có số đo: vẫn vẽ được, nói rõ chưa có dữ liệu', () => {
    const html = renderToStaticMarkup(<TempChart points={[]} minC={2} maxC={8} nowSec={NOW} />);
    expect(html).toContain('Chưa có số đo');
    expect(html).not.toContain('class="line"');
  });
});
