// Biểu đồ đường nhiệt độ bằng SVG viết tay (nhẹ, co giãn theo chiều rộng màn hình).
// Toàn bộ tính toán nằm trong lib/chart.ts (đã có test); ở đây chỉ vẽ.
import { useId } from 'react';
import { buildChart, describeSeries, type ReadingPoint } from '../lib/chart.ts';

export interface TempChartProps {
  points: readonly ReadingPoint[];
  minC: number;
  maxC: number;
  nowSec: number;
  hours?: number;
}

export function TempChart({ points, minC, maxC, nowSec, hours = 24 }: TempChartProps) {
  const uid = useId();
  const chart = buildChart({ points, minC, maxC, nowSec, hours });
  const summary = describeSeries({ points, minC, maxC, nowSec, hours });
  const { layout, plot } = chart;

  return (
    <div>
      <svg
        className="auh-chart"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-labelledby={`${uid}-t ${uid}-d`}
        preserveAspectRatio="xMidYMid meet"
      >
        <title id={`${uid}-t`}>{`Biểu đồ nhiệt độ ${hours} giờ qua`}</title>
        <desc id={`${uid}-d`}>{summary}</desc>

        {/* Vạch chia ngang + nhãn nhiệt độ */}
        {chart.yTicks.map((t) => (
          <g key={`y${t.y}`}>
            <line className="grid" x1={plot.left} x2={plot.right} y1={t.y} y2={t.y} />
            <text x={plot.left - 4} y={t.y + 3} textAnchor="end">
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
          <rect key={`g${i}`} className="gap" x={g.x1} width={Math.max(0, g.x2 - g.x1)} y={plot.top} height={plot.bottom - plot.top} />
        ))}

        {/* Dải min–max, đường trung bình */}
        {chart.segments.map((s, i) => (
          <g key={`s${i}`}>
            {s.envelope && <path className="envelope" d={s.envelope} />}
            {s.line && <path className="line" d={s.line} />}
            {s.dot && <circle className="dot" cx={s.dot.x} cy={s.dot.y} r={2.5} />}
          </g>
        ))}
        {chart.latest && <circle className="latest" cx={chart.latest.x} cy={chart.latest.y} r={4} />}

        {/* Trục giờ (giờ Việt Nam) */}
        {chart.xTicks.map((t) => (
          <text key={`x${t.x}`} x={t.x} y={layout.height - 8} textAnchor={t.x > plot.right - 14 ? 'end' : t.x < plot.left + 14 ? 'start' : 'middle'}>
            {t.label}
          </text>
        ))}
      </svg>

      <div className="auh-legend" aria-hidden="true">
        <span><i style={{ background: 'var(--auh-ok)', opacity: 0.3 }} />Ngưỡng an toàn</span>
        <span><i style={{ background: 'var(--auh-primary)', opacity: 0.3 }} />Thấp nhất – cao nhất</span>
        <span><i style={{ background: 'var(--auh-off)', opacity: 0.3 }} />Mất kết nối</span>
      </div>
      <p className="auh-muted" style={{ marginTop: 8 }} aria-hidden="true">{summary}</p>
      <p className="auh-help">Giờ hiển thị theo giờ Việt Nam.</p>
    </div>
  );
}
