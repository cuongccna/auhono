import { describe, expect, it } from 'vitest';
import { BROWNOUT_HINT, formatUptime, resetReasonText, rssiLevel, rssiText, techRows, WEAK_WIFI_HINT } from './diag.ts';

describe('rssi', () => {
  it('Tốt / Trung bình / Yếu kèm số dBm, đúng ở các biên', () => {
    expect(rssiText(-50)).toBe('Tốt (-50 dBm)');
    expect(rssiText(-60)).toBe('Tốt (-60 dBm)');
    expect(rssiText(-61)).toBe('Trung bình (-61 dBm)');
    expect(rssiText(-75)).toBe('Trung bình (-75 dBm)');
    expect(rssiText(-76)).toBe('Yếu (-76 dBm)');
    expect(rssiLevel(-120)).toBe('weak');
  });
});

describe('lý do khởi động lại', () => {
  it.each([
    ['poweron', 'Cắm điện'],
    ['brownout', 'Điện yếu/sụt áp'],
    ['wdt', 'Lỗi phần mềm (tự khởi động lại)'],
    ['panic', 'Lỗi phần mềm (tự khởi động lại)'],
    ['task_wdt', 'Lỗi phần mềm (tự khởi động lại)'],
    ['sw', 'Khởi động lại theo lệnh'],
    ['ext', 'Nút reset'],
    ['unknown', 'Không rõ'],
    ['deepsleep_x', 'Không rõ'],
    ['BROWNOUT', 'Điện yếu/sụt áp'],
  ])('%s => %s', (rst, text) => expect(resetReasonText(rst)).toBe(text));
});

describe('formatUptime', () => {
  it('ngày/giờ/phút', () => {
    expect(formatUptime(30)).toBe('dưới 1 phút');
    expect(formatUptime(12 * 60)).toBe('12 phút');
    expect(formatUptime(5 * 3600 + 20 * 60)).toBe('5 giờ 20 phút');
    expect(formatUptime(3 * 86400 + 4 * 3600)).toBe('3 ngày 4 giờ');
    expect(formatUptime(-5)).toBe('dưới 1 phút');
  });
});

describe('techRows', () => {
  it('không có dữ liệu gì => rỗng (không hiện mục)', () => {
    expect(techRows({})).toEqual([]);
    expect(techRows({ diag: null, firmware: null })).toEqual([]);
  });
  it('đủ dữ liệu: sóng, lý do khởi động lại, thời gian chạy, đầu dò, phần mềm, giờ cập nhật', () => {
    const rows = techRows({ diag: { rssi: -80, rst: 'brownout', up: 3 * 86400, sensor: 'fault', fault_s: 1200 }, diag_at: Date.UTC(2026, 8, 29, 5, 0) / 1000, firmware: '1.0.2' });
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ['Sóng Wi-Fi', 'Yếu (-80 dBm)'],
      ['Lần khởi động lại gần nhất do', 'Điện yếu/sụt áp'],
      ['Đã chạy liên tục', '3 ngày 0 giờ'],
      ['Đầu dò nhiệt độ', 'Lỗi, không đọc được 20 phút'],
      ['Phiên bản phần mềm', '1.0.2'],
      ['Cập nhật lúc', '12:00 29/09'],
    ]);
    expect(rows[0]!.hint).toBe(WEAK_WIFI_HINT);
    expect(rows[1]!.hint).toBe(BROWNOUT_HINT);
    expect(BROWNOUT_HINT).toContain('củ sạc USB khác');
    expect(WEAK_WIFI_HINT).toContain('kích sóng');
  });
  it('sóng tốt / khởi động do cắm điện: không có gợi ý; chịu thiếu trường', () => {
    const rows = techRows({ diag: { rssi: -50, rst: 'poweron' } });
    expect(rows.every((r) => r.hint === undefined)).toBe(true);
    expect(rows).toHaveLength(2);
  });
  it('chỉ có phần mềm (không diag): không hiện dòng "Cập nhật lúc" của diag', () => {
    expect(techRows({ firmware: '1.0.0', diag_at: 1_800_000_000 }).map((r) => r.label)).toEqual(['Phiên bản phần mềm']);
  });
});
