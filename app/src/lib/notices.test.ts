import { describe, expect, it } from 'vitest';
import { deviceNotices, NOTICE_TEXT } from './notices.ts';

describe('deviceNotices (hợp đồng server mới)', () => {
  it('chưa có người nhận => cảnh báo nổi bật nói rõ sẽ không có tin nhắn nào', () => {
    expect(deviceNotices({ recipient_count: 0 })).toEqual(['no_recipients']);
    expect(NOTICE_TEXT.no_recipients).toBe('Chưa có người nhận cảnh báo — sẽ không có tin nhắn nào được gửi.');
  });
  it('gửi tin lỗi trong 24 giờ qua', () => {
    expect(deviceNotices({ notify_failures_24h: 2 })).toEqual(['notify_failed']);
    expect(deviceNotices({ notify_failures_24h: 0 })).toEqual([]);
    expect(NOTICE_TEXT.notify_failed).toBe('Không gửi được tin cho một số người nhận, hãy kiểm tra số điện thoại/Zalo.');
  });
  it('chưa bật báo động (armed = false)', () => {
    expect(deviceNotices({ armed: false }, 'ok')).toEqual(['not_armed']);
    expect(NOTICE_TEXT.not_armed).toBe('Đang chờ tủ đạt nhiệt độ, chưa cảnh báo.');
    expect(deviceNotices({ armed: true }, 'ok')).toEqual([]);
  });
  it('chưa có số đo nào thì khỏi nói "chưa bật báo động" (đã có hướng dẫn cài đặt)', () => {
    expect(deviceNotices({ armed: false }, 'no_data')).toEqual([]);
  });
  it('đang tạm dừng: không nói "chờ tủ đạt nhiệt độ" nhưng vẫn nhắc thiếu người nhận', () => {
    expect(deviceNotices({ armed: false }, 'paused')).toEqual([]);
    expect(deviceNotices({ armed: false, recipient_count: 0 }, 'paused')).toEqual(['no_recipients']);
  });
  it('server cũ (các trường vắng mặt) => không hiện gì, không đoán', () => {
    expect(deviceNotices({})).toEqual([]);
  });
  it('nhiều cảnh báo: thứ tự quan trọng giảm dần', () => {
    expect(deviceNotices({ recipient_count: 0, notify_failures_24h: 1, armed: false }, 'ok')).toEqual(['no_recipients', 'notify_failed', 'not_armed']);
  });
});
