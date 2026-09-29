// Khách API dùng chung cho toàn ứng dụng: gắn địa chỉ từ cấu hình và token từ Zalo.
import { createApiClient } from './api-client.ts';
import { API_BASE } from './config.ts';
import { getToken } from './sdk.ts';

export const api = createApiClient({ baseUrl: API_BASE, getToken });
export type { ApiClient } from './api-client.ts';
