// Khách API dùng chung cho toàn ứng dụng: gắn địa chỉ từ cấu hình, token từ Zalo và bộ hiệu chỉnh đồng hồ theo giờ server.
import { createApiClient } from './api-client.ts';
import { API_BASE } from './config.ts';
import { syncClock } from './lib/clock.ts';
import { getToken } from './sdk.ts';

export const api = createApiClient({ baseUrl: API_BASE, getToken, onServerTime: syncClock });
export type { ApiClient } from './api-client.ts';
