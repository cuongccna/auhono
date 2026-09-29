import { STATUS_LABEL, type DeviceStatus } from '../lib/status.ts';

const ICON: Record<DeviceStatus, string> = { ok: '✓', alarm: '!', offline: '✕', no_data: '…', paused: 'II', unknown: '?' };

/** Huy hiệu trạng thái: có cả chữ lẫn ký hiệu, không chỉ dựa vào màu. */
export function StatusBadge({ status }: { status: DeviceStatus }) {
  return (
    <span className={`auh-badge auh-badge-${status}`}>
      <span aria-hidden="true">{ICON[status]}</span>
      {STATUS_LABEL[status]}
    </span>
  );
}
