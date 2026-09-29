import { describe, expect, it, vi } from 'vitest';
import {
  buildChart,
  cleanPoints,
  computeYDomain,
  describeSeries,
  BUCKET_SECONDS,
  GAP_SECONDS,
  layoutForWidth,
  niceStep,
  outOfRangeSince,
  scaleLinear,
  splitSegments,
  tickStepFor,
  tickStepHours,
  timeTicks,
  yTickValues,
  type ReadingPoint,
} from './chart.ts';

const pt = (t: number, avg: number, spread = 0.5): ReadingPoint => ({ t, avg, min: avg - spread, max: avg + spread });
/** 24 giờ với mốc "bây giờ" là 2026-09-29 12:00 giờ Việt Nam (05:00 UTC). */
const NOW = Date.UTC(2026, 8, 29, 5, 0) / 1000;

describe('scaleLinear', () => {
  it('nội suy tuyến tính và kẹp trong miền ra', () => {
    const s = scaleLinear(0, 100, 0, 200);
    expect(s(50)).toBe(100);
    expect(s(-10)).toBe(0);
    expect(s(150)).toBe(200);
  });
  it('miền ra đảo chiều (trục y SVG hướng xuống)', () => {
    const s = scaleLinear(-30, -10, 200, 0);
    expect(s(-30)).toBe(200);
    expect(s(-10)).toBe(0);
    expect(s(-20)).toBe(100);
    expect(s(0)).toBe(0); // kẹp
  });
  it('miền vào suy biến không chia cho 0', () => {
    expect(scaleLinear(5, 5, 0, 100)(5)).toBe(50);
  });
});

describe('splitSegments (ngắt đường khi mất kết nối)', () => {
  it('liên tục => 1 đoạn', () => {
    const pts = [pt(0, -20), pt(300, -20), pt(600, -20)];
    expect(splitSegments(pts)).toHaveLength(1);
  });
  it('cách nhau đúng 15 phút chưa tính là mất kết nối; hơn 15 phút thì ngắt', () => {
    expect(splitSegments([pt(0, -20), pt(GAP_SECONDS, -20)])).toHaveLength(1);
    const segs = splitSegments([pt(0, -20), pt(GAP_SECONDS + 1, -20)]);
    expect(segs).toHaveLength(2);
  });
  it('nhiều khoảng trống', () => {
    const pts = [pt(0, 1), pt(300, 1), pt(5000, 1), pt(5300, 1), pt(20000, 1)];
    expect(splitSegments(pts).map((s) => s.length)).toEqual([2, 2, 1]);
  });
  it('rỗng', () => {
    expect(splitSegments([])).toEqual([]);
  });
});

describe('cleanPoints', () => {
  it('sắp xếp, bỏ trùng giờ, bỏ số không hợp lệ', () => {
    const out = cleanPoints([pt(600, 1), pt(0, 2), pt(0, 3), { t: 300, avg: NaN, min: 0, max: 0 }]);
    expect(out.map((p) => p.t)).toEqual([0, 600]);
  });
});

describe('trục nhiệt độ', () => {
  it('niceStep cho bước đẹp', () => {
    expect(niceStep(0, 10, 5)).toBe(2);
    expect(niceStep(0, 100, 5)).toBe(20);
    expect(niceStep(0, 4.3, 5)).toBe(1);
    expect(niceStep(3, 3)).toBe(1);
  });
  it('miền luôn chứa toàn bộ dữ liệu', () => {
    const pts = [pt(0, -22, 1), pt(300, -19, 1)];
    const d = computeYDomain(pts, -40, -18);
    expect(d.lo).toBeLessThanOrEqual(-23);
    expect(d.hi).toBeGreaterThanOrEqual(-18);
  });
  it('ngưỡng ở xa dữ liệu không nén biểu đồ (tủ đông: dữ liệu -20, ngưỡng dưới -40)', () => {
    const d = computeYDomain([pt(0, -20), pt(300, -20)], -40, -18);
    expect(d.lo).toBeGreaterThan(-30);
    expect(d.hi).toBeGreaterThanOrEqual(-18); // ngưỡng trên gần nên được kéo vào
  });
  it('không có dữ liệu thì hiện đúng dải ngưỡng', () => {
    const d = computeYDomain([], 2, 8);
    expect(d.lo).toBeLessThanOrEqual(2);
    expect(d.hi).toBeGreaterThanOrEqual(8);
  });
  it('vạch chia nằm trong miền', () => {
    const ticks = yTickValues(-24, -14, 2);
    expect(ticks).toEqual([-24, -22, -20, -18, -16, -14]);
  });
});

describe('trục giờ Việt Nam', () => {
  it('bước theo độ dài khung', () => {
    expect(tickStepHours(24)).toBe(4);
    expect(tickStepHours(6)).toBe(1);
    expect(tickStepHours(168)).toBe(24);
  });
  it('vạch căn theo giờ VN (chia hết cho 4 giờ, gồm cả hai mép), nửa đêm ghi ngày', () => {
    const ticks = timeTicks(NOW - 24 * 3600, NOW, 4);
    expect(ticks.map((t) => t.label)).toEqual(['12:00', '16:00', '20:00', '29/09', '04:00', '08:00', '12:00']);
    for (const t of ticks) expect(t.t).toBeGreaterThanOrEqual(NOW - 24 * 3600);
    for (const t of ticks) expect(t.t).toBeLessThanOrEqual(NOW);
  });
});

describe('buildChart', () => {
  const base = { minC: -40, maxC: -18, nowSec: NOW, hours: 24 };

  it('điểm liên tục: 1 đường, không có khoảng mất kết nối', () => {
    const pts = Array.from({ length: 12 }, (_, i) => pt(NOW - 3600 + i * 300, -20));
    const c = buildChart({ ...base, points: pts });
    expect(c.segments).toHaveLength(1);
    expect(c.segments[0]!.line.startsWith('M')).toBe(true);
    expect(c.segments[0]!.line.split('L')).toHaveLength(12);
    expect(c.segments[0]!.envelope.endsWith('Z')).toBe(true);
    expect(c.gaps).toHaveLength(0);
    expect(c.latest).not.toBeNull();
  });

  it('khoảng trống giữa hai điểm > 15 phút: hai đường riêng và một vùng mất kết nối ở giữa', () => {
    const a = [pt(NOW - 7200, -20), pt(NOW - 6900, -20)];
    const b = [pt(NOW - 3600, -20), pt(NOW - 3300, -20)];
    const c = buildChart({ ...base, points: [...a, ...b] });
    expect(c.segments).toHaveLength(2);
    // điểm cuối đoạn 1 -> điểm đầu đoạn 2
    const gap = c.gaps.find((g) => g.x2 > g.x1 && g.x2 < c.plot.right)!;
    expect(gap).toBeDefined();
    // Đường thứ nhất không được đi tới điểm của đoạn 2.
    const lastXofFirst = Number(c.segments[0]!.line.split('L').pop()!.split(' ')[0]);
    expect(lastXofFirst).toBeLessThanOrEqual(gap.x1 + 0.1);
  });

  it('thiết bị đang mất kết nối: có khoảng trống từ điểm cuối tới hiện tại', () => {
    const c = buildChart({ ...base, points: [pt(NOW - 7200, -20), pt(NOW - 6900, -20)] });
    expect(c.gaps).toHaveLength(1);
    expect(c.gaps[0]!.x2).toBe(c.plot.right);
  });

  it('đoạn chỉ 1 điểm được vẽ thành chấm', () => {
    const c = buildChart({ ...base, points: [pt(NOW - 100, -20)] });
    expect(c.segments[0]!.dot).not.toBeNull();
    expect(c.segments[0]!.line).toBe('');
  });

  it('không có dữ liệu: cả khung là "không có dữ liệu", không có đường', () => {
    const c = buildChart({ ...base, points: [] });
    expect(c.segments).toHaveLength(0);
    expect(c.latest).toBeNull();
    expect(c.gaps).toHaveLength(1);
  });

  it('mọi toạ độ nằm trong khung vẽ và hữu hạn', () => {
    const pts = Array.from({ length: 288 }, (_, i) => pt(NOW - 86400 + i * 300, -20 + Math.sin(i / 10) * 5, 1));
    const c = buildChart({ ...base, points: pts });
    const nums = (c.segments[0]!.line.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    expect(nums.every(Number.isFinite)).toBe(true);
    for (let i = 0; i < nums.length; i += 2) {
      expect(nums[i]!).toBeGreaterThanOrEqual(c.plot.left - 0.1);
      expect(nums[i]!).toBeLessThanOrEqual(c.plot.right + 0.1);
      expect(nums[i + 1]!).toBeGreaterThanOrEqual(c.plot.top - 0.1);
      expect(nums[i + 1]!).toBeLessThanOrEqual(c.plot.bottom + 0.1);
    }
  });

  it('dải ngưỡng: nhiệt độ cao hơn nằm trên (y nhỏ hơn); đường ngưỡng xa bị bỏ', () => {
    const c = buildChart({ ...base, points: [pt(NOW - 600, -20), pt(NOW - 300, -20)] });
    expect(c.maxLineY).not.toBeNull();
    expect(c.minLineY).toBeNull(); // -40 nằm ngoài miền nhìn
    expect(c.band).not.toBeNull();
    expect(c.band!.y).toBeCloseTo(c.maxLineY!, 5);
    // -20 nằm dưới đường -18 => y lớn hơn
    const yLatest = c.latest!.y;
    expect(yLatest).toBeGreaterThan(c.maxLineY!);
  });

  it('tủ mát: cả hai đường ngưỡng trong khung', () => {
    const c = buildChart({ points: [pt(NOW - 600, 5), pt(NOW - 300, 5.5)], minC: 2, maxC: 8, nowSec: NOW, hours: 24 });
    expect(c.minLineY).not.toBeNull();
    expect(c.maxLineY).not.toBeNull();
    expect(c.minLineY!).toBeGreaterThan(c.maxLineY!);
  });

  it('nhãn trục có giờ VN', () => {
    const c = buildChart({ ...base, points: [] });
    expect(c.xTicks.map((t) => t.label)).toContain('12:00');
    expect(c.xTicks.map((t) => t.label)).toContain('29/09');
  });
});

describe('describeSeries (mô tả chữ)', () => {
  it('không có dữ liệu', () => {
    expect(describeSeries({ points: [], minC: 2, maxC: 8, nowSec: NOW, hours: 24 })).toContain('Chưa có số đo');
  });
  it('tóm tắt thấp nhất/cao nhất/trung bình, trong ngưỡng, mất kết nối', () => {
    const pts = [pt(NOW - 3600, -20, 1), pt(NOW - 3300, -19, 1), pt(NOW - 300, -21, 1)];
    const s = describeSeries({ points: pts, minC: -40, maxC: -18, nowSec: NOW, hours: 24 });
    expect(s).toContain('thấp nhất -22,0°C');
    expect(s).toContain('cao nhất -18,0°C');
    expect(s).toContain('Nhiệt độ luôn trong ngưỡng');
    expect(s).toContain('mất kết nối 1 lần');
  });
  it('báo có vượt ngưỡng', () => {
    const pts = [pt(NOW - 600, -15, 0.5), pt(NOW - 300, -15, 0.5)];
    const s = describeSeries({ points: pts, minC: -40, maxC: -18, nowSec: NOW, hours: 24 });
    expect(s).toContain('khoảng 10 phút');
  });
});

describe('độ bền của biểu đồ (dữ liệu xấu, màn hình nhỏ)', () => {
  const base = { minC: -40, maxC: -18, nowSec: NOW, hours: 24 };
  /** Mọi số trong mô hình (toạ độ, vạch, khoảng) phải hữu hạn; mọi chuỗi path không chứa "NaN"/"Infinity". (JSON.stringify che NaN thành null nên phải đi từng giá trị.) */
  const finiteModel = (c: unknown, path = 'model'): void => {
    if (typeof c === 'number') expect(Number.isFinite(c), `${path} = ${c}`).toBe(true);
    else if (typeof c === 'string') expect(c, path).not.toMatch(/NaN|Infinity|undefined/);
    else if (Array.isArray(c)) c.forEach((v, i) => finiteModel(v, `${path}[${i}]`));
    else if (c && typeof c === 'object') for (const [k, v] of Object.entries(c)) finiteModel(v, `${path}.${k}`);
  };

  it('0 điểm, 1 điểm', () => {
    finiteModel(buildChart({ ...base, points: [] }));
    const one = buildChart({ ...base, points: [pt(NOW - 60, -20)] });
    finiteModel(one);
    expect(one.segments).toHaveLength(1);
    expect(one.segments[0]!.dot).not.toBeNull();
  });

  it('mọi giá trị giống hệt nhau (miền = 0): không chia cho 0, trục vẫn có ít nhất 2 vạch', () => {
    const pts = Array.from({ length: 20 }, (_, i) => ({ t: NOW - 6000 + i * 300, avg: -20, min: -20, max: -20 }));
    const c = buildChart({ ...base, points: pts });
    finiteModel(c);
    expect(c.yDomain.hi).toBeGreaterThan(c.yDomain.lo);
    expect(c.yTicks.length).toBeGreaterThanOrEqual(2);
  });

  it('NaN / Infinity / -Infinity bị loại, phần còn lại vẫn vẽ', () => {
    const pts = [pt(NOW - 1200, -20), { t: NOW - 900, avg: NaN, min: NaN, max: NaN }, { t: NOW - 600, avg: Infinity, min: 0, max: Infinity }, pt(NOW - 300, -21)];
    const c = buildChart({ ...base, points: pts });
    finiteModel(c);
    expect(c.segments.length).toBeGreaterThan(0);
    // ngay cả khi CẢ HAI ngưỡng vô nghĩa cũng không sinh NaN ở dữ liệu
    finiteModel(buildChart({ ...base, points: [pt(NOW - 300, -20)], minC: NaN, maxC: NaN }));
  });

  it('giá trị rất xa dải ngưỡng: trục mở rộng để LUÔN thấy dữ liệu', () => {
    const c = buildChart({ ...base, points: [pt(NOW - 600, -20), pt(NOW - 300, 60)] });
    expect(c.yDomain.hi).toBeGreaterThanOrEqual(60);
    expect(c.yDomain.lo).toBeLessThanOrEqual(-20.5);
    const c2 = buildChart({ minC: 2, maxC: 8, nowSec: NOW, hours: 24, points: [pt(NOW - 600, -35), pt(NOW - 300, 5)] });
    expect(c2.yDomain.lo).toBeLessThanOrEqual(-35.5);
  });

  it('khoảng mất kết nối dài: đường bị ngắt, KHÔNG nội suy qua khoảng trống', () => {
    const before = [pt(NOW - 20000, -20), pt(NOW - 19700, -20)];
    const after = [pt(NOW - 600, -19), pt(NOW - 300, -19)];
    const c = buildChart({ ...base, points: [...before, ...after] });
    expect(c.segments).toHaveLength(2);
    // không path nào chứa cả điểm trước lẫn điểm sau khoảng trống
    const xsOf = (line: string) => (line.match(/-?\d+(\.\d+)? /g) ?? []).map(Number);
    const gap = c.gaps.find((g) => g.x2 < c.plot.right)!;
    for (const seg of c.segments) {
      const xs = xsOf(seg.line);
      expect(xs.every((x) => x <= gap.x1 + 0.1) || xs.every((x) => x >= gap.x2 - 0.1)).toBe(true);
    }
  });

  it('điểm cuối chưa quá cũ: KHÔNG vẽ vùng "mất kết nối" (khung 5 phút => điểm có thể trễ ~5 phút)', () => {
    // Điểm ở đầu khung 5 phút cách nay 19 phút, nghĩa là số đo thật có thể mới 14 phút trước: chưa tới ngưỡng 15 phút.
    const c = buildChart({ ...base, points: [pt(NOW - 19 * 60, -20), pt(NOW - 24 * 60, -20)] });
    expect(c.gaps).toHaveLength(0);
    const d = buildChart({ ...base, points: [pt(NOW - (GAP_SECONDS + BUCKET_SECONDS) - 60, -20)] });
    expect(d.gaps).toHaveLength(1);
  });

  it('rất dày: 2016 điểm (7 ngày) vẫn nhanh và hữu hạn; đường chỉ 1 chữ số lẻ nên gọn', () => {
    const pts = Array.from({ length: 2016 }, (_, i) => pt(NOW - 604800 + i * 300, -20 + Math.sin(i / 7) * 3));
    const t0 = Date.now();
    const c = buildChart({ ...base, hours: 168, points: pts });
    expect(Date.now() - t0).toBeLessThan(500);
    finiteModel(c);
    expect(c.outside.length).toBeLessThanOrEqual(120); // hình thoi ngoài ngưỡng bị giới hạn
  });

  it('điểm ngoài ngưỡng được đánh dấu bằng hình thoi (không chỉ dựa vào màu)', () => {
    const c = buildChart({ ...base, points: [pt(NOW - 900, -20), pt(NOW - 600, -12), pt(NOW - 300, -10)] });
    expect(c.outside).toHaveLength(2);
    expect(buildChart({ ...base, points: [pt(NOW - 300, -20)] }).outside).toHaveLength(0);
  });

  it('nhiệt độ và giờ luôn hiển thị theo giờ Việt Nam, kể cả khi điện thoại đặt múi giờ khác', () => {
    try {
      const at = Date.UTC(2026, 8, 29, 5, 0) / 1000; // 12:00 giờ VN
      for (const tz of ['America/Los_Angeles', 'Asia/Tokyo', 'UTC', 'Pacific/Kiritimati']) {
        vi.stubEnv('TZ', tz);
        const labels = buildChart({ ...base, nowSec: at, points: [] }).xTicks.map((t) => t.label);
        expect(labels).toEqual(['12:00', '16:00', '20:00', '29/09', '04:00', '08:00', '12:00']);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('khung vẽ cho màn hình hẹp (320 px) / chữ to', () => {
  it('layoutForWidth kẹp trong 240..700 và chịu giá trị rác', () => {
    expect(layoutForWidth(288).width).toBe(288);
    expect(layoutForWidth(100).width).toBe(240);
    expect(layoutForWidth(5000).width).toBe(700);
    expect(layoutForWidth(NaN).width).toBe(360);
  });
  it('nhãn giờ thưa hơn khi hẹp để không chồng lên nhau (mỗi nhãn >= ~44 px)', () => {
    expect(tickStepFor(24, 312)).toBe(4); // như cũ ở màn hình 360 px
    expect(tickStepFor(24, 238)).toBe(6); // màn hình 320 px
    expect(tickStepFor(24, 120)).toBeGreaterThanOrEqual(12);
    const narrow = buildChart({ points: [], minC: -40, maxC: -18, nowSec: NOW, hours: 24, layout: layoutForWidth(288) });
    const xs = narrow.xTicks.map((t) => t.x);
    for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(44);
  });
});

describe('outOfRangeSince: "đang vượt ngưỡng từ khi nào"', () => {
  const p = (t: number, avg: number) => pt(t, avg, 0);
  it('null nếu điểm mới nhất trong ngưỡng hoặc không có điểm', () => {
    expect(outOfRangeSince([], -40, -18)).toBeNull();
    expect(outOfRangeSince([p(NOW - 600, -10), p(NOW - 300, -20)], -40, -18)).toBeNull();
  });
  it('tìm điểm đầu của chuỗi liên tục ngoài ngưỡng tính từ điểm mới nhất', () => {
    const r = outOfRangeSince([p(NOW - 1500, -20), p(NOW - 1200, -15), p(NOW - 900, -14), p(NOW - 600, -13), p(NOW - 300, -12)], -40, -18);
    expect(r).toEqual({ since: NOW - 1200, entireWindow: false, direction: 'high' });
  });
  it('lạnh quá (dưới ngưỡng thấp)', () => {
    expect(outOfRangeSince([p(NOW - 600, 5), p(NOW - 300, 1)], 2, 8)).toEqual({ since: NOW - 300, entireWindow: false, direction: 'low' });
  });
  it('lệch suốt cả khung: entireWindow = true (thời điểm thật còn sớm hơn)', () => {
    expect(outOfRangeSince([p(NOW - 600, -10), p(NOW - 300, -10)], -40, -18)).toMatchObject({ since: NOW - 600, entireWindow: true });
  });
  it('không nối qua khoảng mất kết nối', () => {
    const r = outOfRangeSince([p(NOW - 9000, -10), p(NOW - 600, -10), p(NOW - 300, -10)], -40, -18);
    expect(r).toMatchObject({ since: NOW - 600 });
  });
});
