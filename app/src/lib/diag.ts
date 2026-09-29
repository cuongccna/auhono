// Thông tin kỹ thuật của thiết bị (mục "Thông tin kỹ thuật"): chuyển số liệu chẩn đoán thành câu tiếng Việt dễ hiểu.
// Mọi trường đều có thể vắng mặt (thiết bị/server cũ): chỉ hiện dòng nào có dữ liệu.
import { formatVnDateTime } from './format.ts';
import type { Device } from './schemas.ts';

/** Mức Wi-Fi: >= -60 dBm tốt, >= -75 trung bình, còn lại yếu. */
export function rssiLevel(rssi: number): 'good' | 'fair' | 'weak' {
  return rssi >= -60 ? 'good' : rssi >= -75 ? 'fair' : 'weak';
}

export function rssiText(rssi: number): string {
  const label = { good: 'Tốt', fair: 'Trung bình', weak: 'Yếu' }[rssiLevel(rssi)];
  return `${label} (${rssi} dBm)`;
}

/** Lý do khởi động lại → tiếng Việt. Mã lạ => "Không rõ". */
export function resetReasonText(rst: string): string {
  const r = rst.toLowerCase();
  if (r === 'poweron') return 'Cắm điện';
  if (r === 'brownout') return 'Điện yếu/sụt áp';
  if (r === 'sw') return 'Khởi động lại theo lệnh';
  if (r === 'ext') return 'Nút reset';
  if (r === 'panic' || r.includes('wdt')) return 'Lỗi phần mềm (tự khởi động lại)';
  return 'Không rõ';
}

/** "3 ngày 4 giờ", "5 giờ 20 phút", "12 phút", "dưới 1 phút". */
export function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days} ngày ${hours} giờ`;
  if (hours > 0) return `${hours} giờ ${minutes} phút`;
  return minutes > 0 ? `${minutes} phút` : 'dưới 1 phút';
}

export interface TechRow {
  label: string;
  value: string;
  /** Gợi ý xử lý (nếu có). */
  hint?: string;
}

export const BROWNOUT_HINT = 'Nguồn điện yếu làm thiết bị khởi động lại: hãy thử củ sạc USB khác (loại tốt, đủ dòng) hoặc ổ cắm khác.';
export const WEAK_WIFI_HINT = 'Sóng Wi-Fi yếu: hãy dời modem lại gần thiết bị hoặc dùng bộ kích sóng Wi-Fi.';

/** Các dòng thông tin kỹ thuật có dữ liệu. Rỗng nếu không có gì để hiện. */
export function techRows(d: Partial<Pick<Device, 'diag' | 'diag_at' | 'firmware'>>): TechRow[] {
  const rows: TechRow[] = [];
  const diag = d.diag ?? null;
  if (diag?.rssi !== undefined) rows.push({ label: 'Sóng Wi-Fi', value: rssiText(diag.rssi), hint: rssiLevel(diag.rssi) === 'weak' ? WEAK_WIFI_HINT : undefined });
  if (diag?.rst !== undefined) {
    rows.push({ label: 'Lần khởi động lại gần nhất do', value: resetReasonText(diag.rst), hint: diag.rst.toLowerCase() === 'brownout' ? BROWNOUT_HINT : undefined });
  }
  if (diag?.up !== undefined) rows.push({ label: 'Đã chạy liên tục', value: formatUptime(diag.up) });
  if (diag?.sensor === 'fault') {
    rows.push({ label: 'Đầu dò nhiệt độ', value: diag.fault_s !== undefined ? `Lỗi, không đọc được ${formatUptime(diag.fault_s)}` : 'Lỗi, không đọc được' });
  } else if (diag?.sensor === 'ok') {
    rows.push({ label: 'Đầu dò nhiệt độ', value: 'Bình thường' });
  }
  const hasDiag = rows.length > 0;
  if (d.firmware) rows.push({ label: 'Phiên bản phần mềm', value: d.firmware });
  if (hasDiag && d.diag_at) rows.push({ label: 'Cập nhật lúc', value: formatVnDateTime(d.diag_at) });
  return rows;
}
