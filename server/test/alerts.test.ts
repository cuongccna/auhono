import { describe, expect, it } from 'vitest';
import { DEFAULTS, initialState, step, tick, type AlertConfig, type AlertEvent, type AlertState } from '../src/alerts.ts';

// Tủ đông: ngưỡng trên -18°C, phải vượt liên tục 15 phút mới báo.
const cfg: AlertConfig = { minC: -40, maxC: -18, breachSeconds: 15 * 60, ...DEFAULTS };
const T0 = 1_000_000;
const min = (n: number) => n * 60;

/** Đưa vào các số đo mỗi phút từ ts `from`, giá trị lấy từ `temps`. */
function feed(state: AlertState, from: number, temps: number[]) {
  const events: AlertEvent[] = [];
  let s = state;
  temps.forEach((c, i) => {
    const r = step(s, { ts: from + min(i), c }, cfg);
    s = r.state;
    events.push(...r.events);
  });
  return { state: s, events };
}
const rep = (c: number, n: number) => Array<number>(n).fill(c);
const kinds = (e: AlertEvent[]) => e.map((x) => x.kind);

describe('chống báo nhầm', () => {
  it('vượt ngưỡng ít hơn 15 phút thì không báo', () => {
    const r = feed(initialState(), T0, rep(-10, 15)); // 15 số đo = 14 phút giữa số đầu và cuối
    expect(r.events).toEqual([]);
    expect(r.state.phase).toBe('ok');
  });

  it('vượt liên tục đủ 15 phút thì báo đúng một lần', () => {
    const r = feed(initialState(), T0, rep(-10, 16));
    expect(kinds(r.events)).toEqual(['temp_alarm']);
    expect(r.events[0]).toMatchObject({ detail: 'high', tempC: -10 });
    expect(r.state.phase).toBe('temp_alarm');
  });

  it('mở cửa tủ rồi đóng lại (đo về bình thường) thì đếm lại từ đầu', () => {
    // 10 phút nóng, 1 phút bình thường, rồi 10 phút nóng nữa: không đủ 15 phút liên tục.
    const temps = [...rep(-10, 10), -20, ...rep(-10, 10)];
    const r = feed(initialState(), T0, temps);
    expect(r.events).toEqual([]);
  });

  it('đang báo động, các số đo vượt tiếp theo không báo lại', () => {
    const r = feed(initialState(), T0, rep(-10, 60));
    expect(kinds(r.events)).toEqual(['temp_alarm']);
  });

  it('nhiệt độ quá thấp cũng báo (detail = low)', () => {
    const r = feed(initialState(), T0, rep(-45, 16));
    expect(r.events[0]).toMatchObject({ kind: 'temp_alarm', detail: 'low' });
  });
});

describe('thông báo đã ổn', () => {
  it('về bình thường liên tục 5 phút thì báo recovered', () => {
    let r = feed(initialState(), T0, rep(-10, 16));
    r = feed(r.state, T0 + min(16), rep(-20, 6));
    expect(kinds(r.events)).toEqual(['recovered']);
    expect(r.state.phase).toBe('ok');
    expect(r.state.breachSince).toBeNull();
  });

  it('chập chờn quanh ngưỡng: về bình thường ngắn rồi vượt lại thì chưa báo ổn', () => {
    let r = feed(initialState(), T0, rep(-10, 16));
    r = feed(r.state, T0 + min(16), [-20, -20, -10, -20, -20]);
    expect(r.events).toEqual([]);
    expect(r.state.phase).toBe('temp_alarm');
  });
});

describe('chống làm phiền (nhắc lại)', () => {
  const alarmed = () => feed(initialState(), T0, rep(-10, 16)).state;
  const alarmAt = T0 + min(15);

  it('chưa đến 30 phút thì không nhắc', () => {
    const r = tick(alarmed(), alarmAt + min(29), alarmAt + min(29), cfg);
    expect(r.events).toEqual([]);
  });

  it('sau 30 phút nhắc lại, rồi tiếp tục mỗi 30 phút', () => {
    let s = alarmed();
    const out: string[] = [];
    for (const m of [30, 60, 90]) {
      const r = tick(s, alarmAt + min(m), alarmAt + min(m), cfg);
      s = r.state;
      out.push(...kinds(r.events));
    }
    expect(out).toEqual(['temp_reminder', 'temp_reminder', 'temp_reminder']);
  });

  it('nhắc tối đa maxReminders lần', () => {
    let s = alarmed();
    let count = 0;
    for (let i = 1; i <= 20; i++) {
      const now = alarmAt + min(30 * i);
      const r = tick(s, now, now, cfg);
      s = r.state;
      count += r.events.length;
    }
    expect(count).toBe(cfg.maxReminders);
  });

  it('đã về bình thường (đang chờ xác nhận) thì không nhắc', () => {
    let r = feed(initialState(), T0, rep(-10, 16));
    r = feed(r.state, T0 + min(16), rep(-20, 2)); // mới về 1 phút, chưa đủ để báo recovered
    const now = alarmAt + min(35);
    expect(tick(r.state, now, now, cfg).events).toEqual([]);
  });
});

describe('mất kết nối', () => {
  const online = () => feed(initialState(), T0, rep(-20, 5));

  it('im lặng dưới 15 phút thì chưa báo', () => {
    const r = tick(online().state, T0 + min(4) + min(14), T0 + min(4), cfg);
    expect(r.events).toEqual([]);
  });

  it('im lặng đủ 15 phút thì báo offline một lần', () => {
    const lastSeen = T0 + min(4);
    const r1 = tick(online().state, lastSeen + min(15), lastSeen, cfg);
    expect(kinds(r1.events)).toEqual(['offline']);
    const r2 = tick(r1.state, lastSeen + min(20), lastSeen, cfg);
    expect(r2.events).toEqual([]);
  });

  it('vẫn mất kết nối sau 30 phút thì nhắc lại', () => {
    const lastSeen = T0 + min(4);
    const r1 = tick(online().state, lastSeen + min(15), lastSeen, cfg);
    const r2 = tick(r1.state, lastSeen + min(45), lastSeen, cfg);
    expect(kinds(r2.events)).toEqual(['offline_reminder']);
  });

  it('có số đo trở lại và bình thường thì báo reconnected', () => {
    const lastSeen = T0 + min(4);
    const off = tick(online().state, lastSeen + min(15), lastSeen, cfg).state;
    const r = step(off, { ts: lastSeen + min(60), c: -20 }, cfg);
    expect(kinds(r.events)).toEqual(['reconnected']);
    expect(r.state.phase).toBe('ok');
  });

  it('trở lại nhưng nhiệt độ đang lệch thì không báo ổn, bắt đầu đếm vượt ngưỡng', () => {
    const lastSeen = T0 + min(4);
    const off = tick(online().state, lastSeen + min(15), lastSeen, cfg).state;
    const back = lastSeen + min(60);
    const r = feed(off, back, rep(-10, 16));
    expect(kinds(r.events)).toEqual(['temp_alarm']); // không có 'reconnected'
  });

  it('thiết bị chưa từng gửi số đo thì không báo offline', () => {
    expect(tick(initialState(), T0 + min(999), null, cfg).events).toEqual([]);
  });
});

describe('số đo gửi bù muộn', () => {
  it('số đo cũ hơn số đo đã xử lý bị bỏ qua, không đổi trạng thái', () => {
    const s = feed(initialState(), T0, rep(-20, 10)).state;
    const r = step(s, { ts: T0 + min(3), c: 50 }, cfg);
    expect(r.state).toBe(s);
    expect(r.events).toEqual([]);
  });
});
