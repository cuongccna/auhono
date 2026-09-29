// Biểu đồ đường nhiệt độ bằng SVG viết tay (nhẹ, không thư viện).
// Toàn bộ tính toán nằm trong lib/chart.ts (đã có test); ở đây chỉ đo bề rộng và vẽ.
// Không dựa vào màu đơn thuần: vùng mất kết nối có nét gạch chéo, điểm ngoài ngưỡng là hình thoi,
// đường ngưỡng là nét đứt; người mù màu đỏ/xanh vẫn đọc được. Có tóm tắt bằng chữ cho trình đọc màn hình.
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { buildChart, DEFAULT_LAYOUT, describeSeries, layoutForWidth, type ReadingPoint } from '../lib/chart.ts';

export interface TempChartProps {
  points: readonly ReadingPoint[];
  minC: number;
  maxC: number;
  /** "Bây giờ" theo giờ server (Unix giây): mép phải của biểu đồ. */
  nowSec: number;
  hours?: number;
}

/** Bề rộng thật của phần tử (px); đo lại khi xoay màn hình/đổi cỡ chữ. Ngoài trình duyệt (test/SSR) dùng bề rộng mặc định. */
function useWidth(ref: React.RefObject<HTMLElement>): number {
  const [width, setWidth] = useState(DEFAULT_LAYOUT.width);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = Math.round(el.clientWidth);
      if (w > 0) setWidth(w);
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [ref]);
  return width;
}

export function TempChart({ points, minC, maxC, nowSec, hours = 24 }: TempChartProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const holder = useRef<HTMLDivElement>(null);
  const width = useWidth(holder);
  const chart = buildChart({ points, minC, maxC, nowSec, hours, layout: layoutForWidth(width) });
  const summary = describeSeries({ points, minC, maxC, nowSec, hours });
  const { layout, plot } = chart;
  return (
    <div ref={holder}>
      <svg
        className="auh-chart"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-labelledby={`${uid}-t ${uid}-d`}
        preserveAspectRatio="xMidYMid meet"
      >
        <title id={`${uid}-t`}>{`Biểu đồ nhiệt độ ${hours} giờ qua`}</title>
        <desc id={`${uid}-d`}>{summary}</desc>
        <defs>
          {/* Nét gạch chéo cho vùng mất kết nối (không chỉ dựa vào màu) */}
          <pattern id={`${uid}-hatch`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" className="hatch" />
          </pattern>
        </defs>
        {/* Vạch chia ngang + nhãn nhiệt độ */}
        {chart.yTicks.map((t) => (
          <g key={`y${t.y}`}>
            <line className="grid" x1={plot.left} x2={plot.right} y1={t.y} y2={t.y} />
            <text x={plot.left - 4} y={t.y + 4} textAnchor="end">
              {t.label}
            </text>
          </g>
        ))}
        {/* Dải ngưỡng an toàn */}
        {chart.band && <rect className="band" x={plot.left} width={plot.right - plot.left} y={chart.band.y} height={chart.band.height} />}
        {chart.minLineY !== null && <line className="limit" x1={plot.left} x2={plot.right} y1={chart.minLineY} y2={chart.minLineY} />}
        {chart.maxLineY !== null && <line className="limit" x1={plot.left} x2={plot.right} y1={chart.maxLineY} y2={chart.maxLineY} />}
        {/* Khoảng mất kết nối */}
        {chart.gaps.map((g, i) => (
          <rect
            key={`g${i}`}
            className="gap"
            fill={`url(#${uid}-hatch)`}
            x={g.x1}
            width={Math.max(0, g.x2 - g.x1)}
            y={plot.top}
            height={plot.bottom - plot.top}
          />
        ))}
        {/* Dải min–max, đường trung bình */}
        {chart.segments.map((s, i) => (
          <g key={`s${i}`}>
            {s.envelope && <path className="envelope" d={s.envelope} />}
            {s.line && <path className="line" d={s.line} />}
            {s.dot && <circle className="dot" cx={s.dot.x} cy={s.dot.y} r={2.5} />}
          </g>
        ))}
        {/* Điểm ngoài ngưỡng: hình thoi */}
        {chart.outside.map((o, i) => (
          <path key={`o${i}`} className="out" d={`M${o.x} ${o.y - 4}L${o.x + 4} ${o.y}L${o.x} ${o.y + 4}L${o.x - 4} ${o.y}Z`} />
        ))}
        {chart.latest && <circle className="latest" cx={chart.latest.x} cy={chart.latest.y} r={4} />}
        {/* Trục giờ (giờ Việt Nam) */}
        {chart.xTicks.map((t) => (
          <text key={`x${t.x}`} x={t.x} y={layout.height - 10} textAnchor={t.x > plot.right - 14 ? 'end' : t.x < plot.left + 14 ? 'start' : 'middle'}>
            {t.label}
          </text>
        ))}
      </svg>
      <div className="auh-legend" aria-hidden="true">
        <span><i className="auh-key-band" />Ngưỡng an toàn</span>
        <span><i className="auh-key-env" />Thấp nhất – cao nhất</span>
        <span><i className="auh-key-gap" />Mất kết nối (gạch chéo)</span>
        <span><i className="auh-key-out" />Ngoài ngưỡng (hình thoi)</span>
      </div>
      <p className="auh-muted" style={{ marginTop: 8 }} aria-hidden="true">{summary}</p>
      <p className="auh-help">Giờ hiển thị theo giờ Việt Nam.</p>
    </div>
  );
}
