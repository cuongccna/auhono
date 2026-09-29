// Xác thực chủ quán: Mini App gửi Zalo access token, ta hỏi Zalo xem token đó của ai.
import { sha256Hex } from './crypto.ts';

export interface ZaloUser {
  id: string;
  name: string | null;
}

/** Lỗi khi không hỏi được Zalo (mạng/5xx): khác với "token sai" để app không bắt chủ quán cấp quyền lại vô ích. */
export class AuthUnavailableError extends Error {}

/** Trả null nếu token sai/hết hạn; ném AuthUnavailableError nếu Zalo đang lỗi. */
export type OwnerVerifier = (token: string) => Promise<ZaloUser | null>;

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { user: ZaloUser; expires: number }>();

/** Gọi Graph API của Zalo. Cache 60 giây theo băm của token để giảm số lần gọi. */
export function zaloVerifier(fetchFn: typeof fetch = fetch): OwnerVerifier {
  return async (token) => {
    const key = await sha256Hex(token);
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.user;

    let res: Response;
    try {
      res = await fetchFn('https://graph.zalo.me/v2.0/me?fields=id,name', {
        headers: { access_token: token },
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new AuthUnavailableError('zalo unreachable');
    }
    if (res.status >= 500 || res.status === 429) throw new AuthUnavailableError(`zalo ${res.status}`);
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { id?: string; name?: string; error?: number } | null;
    if (!body || body.error || !body.id) return null;

    const user = { id: String(body.id), name: body.name ?? null };
    if (cache.size > 500) cache.clear(); // chặn phình bộ nhớ
    cache.set(key, { user, expires: Date.now() + CACHE_TTL_MS });
    return user;
  };
}
