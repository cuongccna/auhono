import { describe, expect, it } from 'vitest';
import { isTelegramUrl, LINK_ONE_TIME_NOTE, MODE_LABEL, MODE_ORDER, shareMessage, TELEGRAM_HELP, TELEGRAM_ONLY_WARNING } from './telegram.ts';

describe('isTelegramUrl: chỉ https://t.me/<bot>?start=<mã>', () => {
  it.each([
    'https://t.me/AuhonoBot?start=abcDEF123_-xyz',
    'https://t.me/auhono_alert_bot?start=Zm9vYmFyYmF6cXV4MTIz',
  ])('chấp nhận %s', (u) => expect(isTelegramUrl(u)).toBe(true));

  it.each([
    ['http (không mã hóa)', 'http://t.me/AuhonoBot?start=abc'],
    ['host lạ', 'https://evil.example/AuhonoBot?start=abc'],
    ['host giả có t.me ở sau', 'https://t.me.evil.example/AuhonoBot?start=abc'],
    ['host giả có t.me ở trước', 'https://evil-t.me/AuhonoBot?start=abc'],
    ['user@ đánh lừa', 'https://t.me@evil.example/AuhonoBot?start=abc'],
    ['cổng lạ', 'https://t.me:8443/AuhonoBot?start=abc'],
    ['telegram.me (không phải t.me)', 'https://telegram.me/AuhonoBot?start=abc'],
    ['scheme tg://', 'tg://resolve?domain=AuhonoBot&start=abc'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['thiếu start', 'https://t.me/AuhonoBot'],
    ['tham số thừa', 'https://t.me/AuhonoBot?start=abc&x=1'],
    ['có fragment', 'https://t.me/AuhonoBot?start=abc#x'],
    ['đường dẫn thêm', 'https://t.me/AuhonoBot/extra?start=abc'],
    ['mã có ký tự lạ', 'https://t.me/AuhonoBot?start=ab%20c'],
    ['mã rỗng', 'https://t.me/AuhonoBot?start='],
    ['khoảng trắng / xuống dòng', 'https://t.me/AuhonoBot?start=abc\n'],
    ['chữ hoa T.ME', 'https://T.ME/AuhonoBot?start=abc'],
    ['tên bot quá ngắn', 'https://t.me/ab?start=abc'],
    ['quá dài', 'https://t.me/AuhonoBot?start=' + 'a'.repeat(300)],
    ['rỗng', ''],
  ])('từ chối: %s', (_name, u) => expect(isTelegramUrl(u)).toBe(false));

  it('từ chối giá trị không phải chuỗi', () => {
    for (const v of [null, undefined, 5, {}, ['https://t.me/AuhonoBot?start=abc']]) expect(isTelegramUrl(v)).toBe(false);
  });
});

describe('câu chữ', () => {
  it('cảnh báo "Chỉ Telegram" đúng nguyên văn', () => {
    expect(TELEGRAM_ONLY_WARNING).toBe('Người này sẽ không nhận tin Zalo. Nếu tắt Telegram hoặc chặn bot, họ sẽ không nhận được gì.');
  });
  it('nhãn ba kênh và thứ tự', () => {
    expect(MODE_ORDER.map((m) => MODE_LABEL[m])).toEqual(['Zalo + Telegram', 'Chỉ Telegram', 'Chỉ Zalo']);
  });
  it('trợ giúp: miễn phí, dự phòng, cả hai kênh, người nhận chính chỉ Zalo còn Telegram thì tất cả', () => {
    expect(TELEGRAM_HELP).toContain('miễn phí');
    expect(TELEGRAM_HELP).toContain('dự phòng');
    expect(TELEGRAM_HELP).toContain('cả hai tin');
    expect(TELEGRAM_HELP).toContain('chỉ người nhận chính nhận tin nhắc lại qua Zalo');
    expect(TELEGRAM_HELP).toContain('đều nhận tin nhắc lại qua Telegram');
  });
  it('nêu rõ liên kết dùng một lần, 24 giờ', () => {
    expect(LINK_ONE_TIME_NOTE).toBe('Liên kết chỉ dùng được một lần và có hiệu lực 24 giờ.');
    const m = shareMessage('Vợ', 'https://t.me/AuhonoBot?start=abc');
    expect(m).toContain('Vợ');
    expect(m).toContain('https://t.me/AuhonoBot?start=abc');
    expect(m).toContain('24 giờ');
  });
});
