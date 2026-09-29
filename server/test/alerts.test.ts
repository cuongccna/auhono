import { describe, expect, it } from 'vitest';
import { DEFAULTS, initialState, step, tick, type AlertConfig, type AlertEvent, type AlertState } from '../src/alerts.ts';

// Tủ đông: ngưỡng trên -18°C, phải vượt liên tục 15 phút mới báo.
const cfg: AlertConfig = { minC: -40, maxC: -18, breachSeconds: 15 * 60, ...DEFAULTS };
/** Thiết bị đã từng thấy nhiệt độ trong ngưỡng (đã armed): hành vi bình thường của tủ đang chạy. */
const armedState = (): AlertState => ({ ...initialState(), armed: true });
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
    const r = feed(armedState(), T0, rep(-10, 15)); // 15 số đo = 14 phút giữa số đầu và cuối
    expect(r.events).toEqual([]);
    expect(r.state.phase).toBe('ok');
  });

  it('vượt liên tục đủ 15 phút thì báo đúng một lần', () => {
    const r = feed(armedState(), T0, rep(-10, 16));
    expect(kinds(r.events)).toEqual(['temp_alarm']);
    expect(r.events[0]).toMatchObject({ detail: 'high', tempC: -10 });
    expect(r.state.phase).toBe('temp_alarm');
  });

  it('mở cửa tủ rồi đóng hẳn (về bình thường >= 3 phút) thì đếm lại từ đầu', () => {
    // 10 phút nóng, 3 phút bình thường, rồi 10 phút nóng nữa: không đủ 15 phút liên tục.
    const temps = [...rep(-10, 10), ...rep(-20, 3), ...rep(-10, 10)];
    const r = feed(armedState(), T0, temps);
    expect(r.events).toEqual([]);
  });

  it('cảm biến nhiễu quanh ngưỡng: dao động ngắn vào trong ngưỡng không reset bộ đếm', () => {
    // Nóng 10 phút, tụt vào ngưỡng 2 mẫu (< 2 phút liên tục), rồi nóng tiếp: vẫn tính là liên tục.
    const temps = [...rep(-10, 10), -20, -20, ...rep(-10, 10)];
    const r = feed(armedState(), T0, temps);
    expect(kinds(r.events)).toEqual(['temp_alarm']);
  });

  it('đang báo động, các số đo vượt tiếp theo không báo lại', () => {
    const r = feed(armedState(), T0, rep(-10, 60));
    expect(kinds(r.events)).toEqual(['temp_alarm']);
  });

  it('nhiệt độ quá thấp cũng báo (detail = low)', () => {
    const r = feed(armedState(), T0, rep(-45, 16));
    expect(r.events[0]).toMatchObject({ kind: 'temp_alarm', detail: 'low' });
  });
});

describe('thông báo đã ổn', () => {
  it('về bình thường liên tục 5 phút thì báo recovered', () => {
    let r = feed(armedState(), T0, rep(-10, 16));
    r = feed(r.state, T0 + min(16), rep(-20, 6));
    expect(kinds(r.events)).toEqual(['recovered']);
    expect(r.state.phase).toBe('ok');
    expect(r.state.breachSince).toBeNull();
  });

  it('chập chờn quanh ngưỡng: về bình thường ngắn rồi vượt lại thì chưa báo ổn', () => {
    let r = feed(armedState(), T0, rep(-10, 16));
    r = feed(r.state, T0 + min(16), [-20, -20, -10, -20, -20]);
    expect(r.events).toEqual([]);
    expect(r.state.phase).toBe('temp_alarm');
  });
});

describe('chống làm phiền (nhắc lại)', () => {
  const alarmed = () => feed(armedState(), T0, rep(-10, 16)).state;
  const alarmAt = T0 + min(15);

  it('chưa đến 30 phút thì không nhắc', () => {
    const r = tick(alarmed(), alarmAt + min(29), alarmAt + min(29), cfg);
    expect(r.events).toEqual([]);
  });

  it('4 lần đầu nhắc mỗi 30 phút', () => {
    let s = alarmed();
    const out: string[] = [];
    for (const m of [30, 60, 90, 120]) {
      const r = tick(s, alarmAt + min(m), alarmAt + min(m), cfg);
      s = r.state;
      out.push(...kinds(r.events));
    }
    expect(out).toEqual(['temp_reminder', 'temp_reminder', 'temp_reminder', 'temp_reminder']);
  });

  it('sự cố kéo dài: sau 4 lần nhắc dày thì nhắc thưa mỗi 2 giờ, không im lặng', () => {
    let s = alarmed();
    let now = alarmAt;
    const times: number[] = [];
    // Cron chạy mỗi 5 phút suốt 30 giờ.
    for (; now < alarmAt + 30 * 3600; now += min(5)) {
      const r = tick(s, now, now, cfg); // thiết bị vẫn gửi số đo (vẫn nóng)
      s = r.state;
      if (r.events.length) times.push(now - alarmAt);
    }
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    expect(times).toHaveLength(cfg.maxReminders); // dừng ở mức trần
    expect(gaps.slice(0, 3)).toEqual([1800, 1800, 1800]);
    expect(gaps.slice(3)).toEqual(Array(cfg.maxReminders - 4).fill(7200));
    expect(times[times.length - 1]).toBeGreaterThanOrEqual(24 * 3600); // vẫn nhắc sau 24 giờ
  });

  it('đã về bình thường (đang chờ xác nhận) thì không nhắc', () => {
    let r = feed(armedState(), T0, rep(-10, 16));
    r = feed(r.state, T0 + min(16), rep(-20, 2)); // mới về 1 phút, chưa đủ để báo recovered
    const now = alarmAt + min(35);
    expect(tick(r.state, now, now, cfg).events).toEqual([]);
  });
});

describe('mất kết nối', () => {
  const online = () => feed(armedState(), T0, rep(-20, 5));

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
    expect(tick(armedState(), T0 + min(999), null, cfg).events).toEqual([]);
  });
});

describe('số đo gửi bù muộn', () => {
  it('số đo cũ hơn số đo đã xử lý bị bỏ qua, không đổi trạng thái', () => {
    const s = feed(armedState(), T0, rep(-20, 10)).state;
    const r = step(s, { ts: T0 + min(3), c: 50 }, cfg);
    expect(r.state).toBe(s);
    expect(r.events).toEqual([]);
  });
});

describe('lắp vào tủ đang ấm (chưa armed)', () => {
  it('nóng liên tục nhiều giờ ngay từ đầu vẫn không báo động dồn dập', () => {
    const r = feed(initialState(), T0, rep(10, 11 * 60)); // 11 giờ ở +10°C
    expect(r.events).toEqual([]);
    expect(r.state.armed).toBe(false);
  });

  it('tủ đạt ngưỡng một lần => armed, sau đó vượt 15 phút là báo', () => {
    let r = feed(initialState(), T0, [...rep(10, 30), ...rep(-20, 5)]);
    expect(r.state.armed).toBe(true);
    r = feed(r.state, T0 + min(35), rep(-10, 16));
    expect(kinds(r.events)).toEqual(['temp_alarm']);
  });

  it('quá warmupMaxSeconds vẫn ấm (tủ hỏng từ đầu) thì vẫn báo', () => {
    const r = feed(initialState(), T0, rep(10, 12 * 60 + 1));
    expect(kinds(r.events)).toEqual(['temp_alarm']);
  });
});

describe('thiết bị chưa từng kết nối', () => {
  const claimedAt = T0;
  it('dưới 60 phút thì chưa báo; đủ 60 phút báo một lần (never_seen)', () => {
    expect(tick(initialState(), claimedAt + min(59), null, cfg, claimedAt).events).toEqual([]);
    const r = tick(initialState(), claimedAt + min(60), null, cfg, claimedAt);
    expect(r.events).toMatchObject([{ kind: 'offline', detail: 'never_seen' }]);
    expect(tick(r.state, claimedAt + min(65), null, cfg, claimedAt).events).toEqual([]);
  });

  it('lần đầu có số đo trong ngưỡng => reconnected và armed', () => {
    const off = tick(initialState(), claimedAt + min(60), null, cfg, claimedAt).state;
    const r = step(off, { ts: claimedAt + min(90), c: -20 }, cfg);
    expect(kinds(r.events)).toEqual(['reconnected']);
    expect(r.state.armed).toBe(true);
  });

  it('chưa gắn chủ (claimedAt null) và chưa gửi gì thì không báo', () => {
    expect(tick(initialState(), T0 + min(9999), null, cfg, null).events).toEqual([]);
  });
});
