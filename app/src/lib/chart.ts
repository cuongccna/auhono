// Tính toán cho biểu đồ nhiệt độ: HÀM THUẦN (không React, không DOM) nên test được dễ dàng.
// Biến dữ liệu server (điểm gộp 5 phút) thành toạ độ SVG: đường trung bình, dải min/max,
// dải ngưỡng, khoảng mất kết nối (ngắt đường khi 2 điểm liền kề cách nhau > 15 phút) và trục giờ Việt Nam.

import { formatTemp, formatTempShort, formatVnDate, formatVnTime, vnParts, VN_OFFSET_SECONDS } from './format.ts';

export interface ReadingPoint {
  /** Unix giây, đầu khung 5 phút. */
  t: number;
  avg: number;
  min: number;
  max: number;
}

/** Hai điểm liền kề cách nhau quá ngần này (giây) => thiết bị đã mất kết nối giữa chừng. */
export const GAP_SECONDS = 15 * 60;
/** Server gộp số đo theo khung 5 phút; `t` là ĐẦU khung nên số đo thật có thể muộn hơn `t` tới ~5 phút. */
export const BUCKET_SECONDS = 5 * 60;

export interface ChartLayout {
  width: number;
  height: number;
  padLeft: number;
  padRight: number;
  padTop: number;
  padBottom: number;
}

export const DEFAULT_LAYOUT: ChartLayout = { width: 360, height: 220, padLeft: 38, padRight: 10, padTop: 10, padBottom: 26 };

/**
 * Khung vẽ theo bề rộng thật của màn hình (px). viewBox = số px thật nên chữ trong SVG giữ cỡ cố định
 * (không bị co nhỏ khi màn hình 320 px). Kẹp trong 240..700 để không vỡ bố cục.
 */
export function layoutForWidth(widthPx: number): ChartLayout {
  const width = Math.round(Math.min(700, Math.max(240, Number.isFinite(widthPx) ? widthPx : DEFAULT_LAYOUT.width)));
  return { width, height: width < 340 ? 210 : 240, padLeft: 42, padRight: 12, padTop: 12, padBottom: 30 };
}

/** Sắp xếp theo thời gian, bỏ điểm trùng giờ và điểm có số không hợp lệ. */
export function cleanPoints(points: readonly ReadingPoint[]): ReadingPoint[] {
  const sorted = points
    .filter((p) => [p.t, p.avg, p.min, p.max].every(Number.isFinite))
    .slice()
    .sort((a, b) => a.t - b.t);
  return sorted.filter((p, i) => i === 0 || p.t !== sorted[i - 1]!.t);
}

/** Tách thành các đoạn liên tục; ngắt đoạn khi hai điểm liền kề cách nhau > gapSeconds. */
export function splitSegments(points: readonly ReadingPoint[], gapSeconds = GAP_SECONDS): ReadingPoint[][] {
  const segments: ReadingPoint[][] = [];
  let current: ReadingPoint[] = [];
  for (const p of points) {
    const prev = current[current.length - 1];
    if (prev && p.t - prev.t > gapSeconds) {
      segments.push(current);
      current = [];
    }
    current.push(p);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/** Tỉ lệ tuyến tính, kẹp trong miền ra (điểm sát mép không tràn khỏi khung). */
export function scaleLinear(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
  if (d0 === d1) return () => (r0 + r1) / 2;
  const lo = Math.min(r0, r1);
  const hi = Math.max(r0, r1);
  return (v) => Math.min(hi, Math.max(lo, r0 + ((v - d0) / (d1 - d0)) * (r1 - r0)));
}

/** Làm tròn số dạng chuỗi ngắn cho đường path (1 chữ số lẻ). */
const n1 = (v: number) => String(Math.round(v * 10) / 10);

/** Bước chia "đẹp" (1, 2, 2.5, 5 × 10^k) cho khoảng [lo, hi] với ~target vạch. */
export function niceStep(lo: number, hi: number, target = 5): number {
  const raw = (hi - lo) / Math.max(1, target);
  if (!(raw > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * Miền trục nhiệt độ. Luôn thấy dữ liệu; chỉ kéo thêm đường ngưỡng vào khi nó ở gần dữ liệu
 * (tủ đông có ngưỡng dưới -40°C mà dữ liệu quanh -20°C thì không nén biểu đồ vì đường -40).
 * Không có dữ liệu thì hiện đúng dải ngưỡng.
 */
export function computeYDomain(points: readonly ReadingPoint[], minC: number, maxC: number): { lo: number; hi: number; step: number } {
  let lo: number;
  let hi: number;
  if (points.length === 0) {
    lo = minC;
    hi = maxC;
  } else {
    lo = Math.min(...points.map((p) => p.min));
    hi = Math.max(...points.map((p) => p.max));
    const reach = Math.max(6, hi - lo);
    const dataLo = lo;
    const dataHi = hi;
    for (const limit of [minC, maxC]) {
      if (limit >= dataLo - reach && limit <= dataHi + reach) {
        lo = Math.min(lo, limit);
        hi = Math.max(hi, limit);
      }
    }
  }
  const pad = Math.max(1, (hi - lo) * 0.1);
  const step = niceStep(lo - pad, hi + pad);
  return {
    lo: round6(Math.floor((lo - pad) / step) * step),
    hi: round6(Math.ceil((hi + pad) / step) * step),
    step,
  };
}

/** Các giá trị vạch chia trên trục dọc. */
export function yTickValues(lo: number, hi: number, step: number): number[] {
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(round6(v));
  return out;
}

export interface TimeTick {
  t: number;
  label: string;
}

/** Bước (giờ) giữa các vạch giờ theo độ dài khung nhìn. */
export function tickStepHours(hours: number): number {
  return hours <= 6 ? 1 : hours <= 12 ? 2 : hours <= 24 ? 4 : hours <= 72 ? 12 : 24;
}

/**
 * Như tickStepHours nhưng thưa hơn khi khung vẽ hẹp (màn hình 320 px, chữ to) để nhãn giờ không chồng lên nhau:
 * mỗi nhãn cần ~44 px chiều ngang.
 */
export function tickStepFor(hours: number, plotWidthPx: number): number {
  let step = tickStepHours(hours);
  const steps = [1, 2, 3, 4, 6, 12, 24, 48, 72];
  const fits = (h: number) => (hours / h) * 44 <= plotWidthPx;
  for (const candidate of steps) {
    if (candidate >= step && fits(candidate)) return candidate;
  }
  step = steps[steps.length - 1]!;
  return step;
}

/**
 * Từ khi nào nhiệt độ liên tục ở ngoài ngưỡng cho tới điểm mới nhất? Dùng để nói "đang vượt ngưỡng từ khoảng 13:20".
 * Trả null nếu điểm mới nhất trong ngưỡng (hoặc không có điểm). `entireWindow` = suốt cả khung dữ liệu đều lệch,
 * nghĩa là thời điểm thật còn sớm hơn `since`.
 */
export function outOfRangeSince(
  points: readonly ReadingPoint[],
  minC: number,
  maxC: number,
): { since: number; entireWindow: boolean; direction: 'high' | 'low' } | null {
  const pts = cleanPoints(points);
  const outside = (p: ReadingPoint) => p.avg > maxC || p.avg < minC;
  const last = pts[pts.length - 1];
  if (!last || !outside(last)) return null;
  let i = pts.length - 1;
  while (i > 0 && outside(pts[i - 1]!) && pts[i]!.t - pts[i - 1]!.t <= GAP_SECONDS) i--;
  return { since: pts[i]!.t, entireWindow: i === 0, direction: last.avg > maxC ? 'high' : 'low' };
}

/** Vạch giờ căn theo GIỜ VIỆT NAM (00:00, 04:00, 08:00...). Nửa đêm ghi ngày (30/09). */
export function timeTicks(startSec: number, endSec: number, stepHours: number): TimeTick[] {
  const stepSec = stepHours * 3600;
  const ticks: TimeTick[] = [];
  let t = Math.ceil((startSec + VN_OFFSET_SECONDS) / stepSec) * stepSec - VN_OFFSET_SECONDS;
  for (; t <= endSec; t += stepSec) {
    const midnight = vnParts(t).hour === 0;
    ticks.push({ t, label: midnight || stepHours >= 24 ? formatVnDate(t) : formatVnTime(t) });
  }
  return ticks;
}

export interface ChartSegment {
  /** "M x y L x y ..." đường trung bình (rỗng nếu đoạn chỉ có 1 điểm). */
  line: string;
  /** Đa giác dải min–max (rỗng nếu đoạn chỉ có 1 điểm). */
  envelope: string;
  /** Đoạn chỉ có 1 điểm: vẽ chấm tròn vì đường 1 điểm không nhìn thấy. */
  dot: { x: number; y: number } | null;
}

export interface ChartModel {
  layout: ChartLayout;
  plot: { left: number; right: number; top: number; bottom: number };
  xDomain: { start: number; end: number };
  yDomain: { lo: number; hi: number };
  /** Dải ngưỡng an toàn (đã kẹp trong khung); null nếu nằm hẳn ngoài. */
  band: { y: number; height: number } | null;
  /** Đường ngưỡng dưới/trên (toạ độ y) nếu nằm trong khung. */
  minLineY: number | null;
  maxLineY: number | null;
  segments: ChartSegment[];
  /** Khoảng mất kết nối (giữa các đoạn và từ điểm cuối đến hiện tại). */
  gaps: { x1: number; x2: number }[];
  xTicks: { x: number; label: string }[];
  yTicks: { y: number; label: string }[];
  /** Vị trí điểm mới nhất để đánh dấu. */
  latest: { x: number; y: number } | null;
  /** Các điểm (trung bình) nằm ngoài ngưỡng: vẽ bằng hình thoi để không phải phân biệt chỉ bằng màu. */
  outside: { x: number; y: number }[];
}

export interface ChartInput {
  points: readonly ReadingPoint[];
  minC: number;
  maxC: number;
  /** Bây giờ (Unix giây); mép phải của biểu đồ. */
  nowSec: number;
  hours: number;
  layout?: ChartLayout;
}

/** Dựng toàn bộ mô hình biểu đồ (toạ độ SVG) từ dữ liệu thô. */
export function buildChart(input: ChartInput): ChartModel {
  const layout = input.layout ?? DEFAULT_LAYOUT;
  const plot = {
    left: layout.padLeft,
    right: layout.width - layout.padRight,
    top: layout.padTop,
    bottom: layout.height - layout.padBottom,
  };
  const points = cleanPoints(input.points);
  const start = input.nowSec - input.hours * 3600;
  const end = input.nowSec;
  const y = computeYDomain(points, input.minC, input.maxC);

  const sx = scaleLinear(start, end, plot.left, plot.right);
  const sy = scaleLinear(y.lo, y.hi, plot.bottom, plot.top);
  const inY = (v: number) => v >= y.lo && v <= y.hi;

  const segs = splitSegments(points);
  const segments: ChartSegment[] = segs.map((seg) => {
    if (seg.length === 1) {
      const p = seg[0]!;
      return { line: '', envelope: '', dot: { x: sx(p.t), y: sy(p.avg) } };
    }
    const at = (p: ReadingPoint, v: number) => `${n1(sx(p.t))} ${n1(sy(v))}`;
    const line = 'M' + seg.map((p) => at(p, p.avg)).join('L');
    const top = seg.map((p) => at(p, p.max));
    const bottom = seg.map((p) => at(p, p.min)).reverse();
    return { line, envelope: 'M' + top.join('L') + 'L' + bottom.join('L') + 'Z', dot: null };
  });

  const gaps: { x1: number; x2: number }[] = [];
  for (let i = 1; i < segs.length; i++) {
    gaps.push({ x1: sx(segs[i - 1]![segs[i - 1]!.length - 1]!.t), x2: sx(segs[i]![0]!.t) });
  }
  const last = points[points.length - 1];
  if (last && end - (last.t + BUCKET_SECONDS) > GAP_SECONDS) gaps.push({ x1: sx(last.t), x2: plot.right });
  if (!last) gaps.push({ x1: plot.left, x2: plot.right }); // không có điểm nào: cả khung là "không có dữ liệu"

  const bandTop = Math.min(input.maxC, y.hi);
  const bandBottom = Math.max(input.minC, y.lo);
  const band = bandTop > bandBottom ? { y: sy(bandTop), height: sy(bandBottom) - sy(bandTop) } : null;

  return {
    layout,
    plot,
    xDomain: { start, end },
    yDomain: { lo: y.lo, hi: y.hi },
    band,
    minLineY: inY(input.minC) ? sy(input.minC) : null,
    maxLineY: inY(input.maxC) ? sy(input.maxC) : null,
    segments,
    gaps,
    xTicks: timeTicks(start, end, tickStepFor(input.hours, plot.right - plot.left)).map((t) => ({ x: sx(t.t), label: t.label })),
    yTicks: yTickValues(y.lo, y.hi, y.step).map((v) => ({ y: sy(v), label: formatTempShort(v) })),
    latest: last ? { x: sx(last.t), y: sy(last.avg) } : null,
    // Tối đa 120 điểm gần nhất để SVG không phình khi cả ngày đều lệch.
    outside: points
      .filter((p) => p.avg > input.maxC || p.avg < input.minC)
      .slice(-120)
      .map((p) => ({ x: sx(p.t), y: sy(p.avg) })),
  };
}

/** Câu mô tả bằng chữ cho người dùng đọc màn hình / xem nhanh, không cần nhìn hình. */
export function describeSeries(input: { points: readonly ReadingPoint[]; minC: number; maxC: number; nowSec: number; hours: number }): string {
  const points = cleanPoints(input.points);
  const span = `${input.hours} giờ qua`;
  if (points.length === 0) return `Chưa có số đo nào trong ${span}.`;

  const lowest = Math.min(...points.map((p) => p.min));
  const highest = Math.max(...points.map((p) => p.max));
  const avg = points.reduce((s, p) => s + p.avg, 0) / points.length;
  const last = points[points.length - 1]!;

  const parts = [
    `Trong ${span}: thấp nhất ${formatTemp(lowest)}, cao nhất ${formatTemp(highest)}, trung bình ${formatTemp(avg)}.`,
    `Số đo gần nhất ${formatTemp(last.avg)} lúc ${formatVnTime(last.t)}.`,
    `Ngưỡng an toàn từ ${formatTemp(input.minC)} đến ${formatTemp(input.maxC)}.`,
  ];

  const outside = points.filter((p) => p.max > input.maxC || p.min < input.minC).length;
  parts.push(outside > 0 ? `Có khoảng ${outside * 5} phút nhiệt độ ra ngoài ngưỡng.` : 'Nhiệt độ luôn trong ngưỡng.');

  const segs = splitSegments(points);
  const gapCount = segs.length - 1 + (input.nowSec - (last.t + BUCKET_SECONDS) > GAP_SECONDS ? 1 : 0);
  if (gapCount > 0) parts.push(`Thiết bị mất kết nối ${gapCount} lần (chỗ đường bị đứt).`);
  return parts.join(' ');
}
