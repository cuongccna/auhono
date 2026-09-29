// Các thao tác GHI có xử lý "đã thành công nhưng mất phản hồi" (điện thoại yếu mạng: server làm xong rồi mà app không nhận được trả lời).
// Nguyên tắc: bấm lại phải an toàn, và nếu server thực ra đã làm xong thì coi là THÀNH CÔNG, không báo lỗi khó hiểu.
// Tách khỏi React, nhận `api` từ ngoài để test được.
import type { ApiClient, ClaimInput } from './api-client.ts';
import { isAmbiguous, isAppError } from './lib/errors.ts';
import type { Recipient } from './lib/schemas.ts';

type Api = Pick<ApiClient, 'claimDevice' | 'listDevices' | 'listRecipients' | 'addRecipient' | 'removeDevice'>;

/**
 * Kích hoạt thiết bị. Server trả 200 khi chính chủ gọi lại nên bấm lại là an toàn.
 * Nếu lần gửi gặp lỗi không rõ kết quả (mất mạng/quá hạn/5xx), kiểm tra danh sách thiết bị: đã có thì coi như xong.
 */
export async function claimDevice(api: Api, input: ClaimInput): Promise<void> {
  try {
    await api.claimDevice(input);
  } catch (e) {
    if (!isAmbiguous(e)) throw e;
    let owned = false;
    try {
      owned = (await api.listDevices()).some((d) => d.id === input.device_id);
    } catch {
      /* vẫn không liên lạc được: báo lỗi gốc, người dùng bấm lại được */
    }
    if (!owned) throw e;
  }
}

/**
 * Thêm người nhận. Server dùng "thêm hoặc cập nhật" theo số nên gửi lại an toàn, NHƯNG nếu lần đầu đã thêm người thứ 5
 * mà mất phản hồi thì lần gửi lại bị 409 "đủ 5 người". Vì vậy khi lỗi không rõ kết quả hoặc 409, đọc lại danh sách:
 * số đó đã nằm trong danh sách thì là thành công.
 */
export async function addRecipient(api: Api, deviceId: string, input: { name: string; phone: string }): Promise<Recipient | null> {
  try {
    return await api.addRecipient(deviceId, input);
  } catch (e) {
    const tooMany = isAppError(e) && e.code === 'too_many_recipients';
    if (!isAmbiguous(e) && !tooMany) throw e;
    let found: Recipient | undefined;
    try {
      found = (await api.listRecipients(deviceId)).find((r) => r.phone === input.phone);
    } catch {
      /* không kiểm tra được */
    }
    if (!found) throw e;
    return found;
  }
}

/**
 * Gỡ thiết bị. Gỡ lần hai (sau khi lần một đã xong nhưng mất phản hồi) server trả 404: coi là đã gỡ xong.
 */
export async function removeDevice(api: Api, deviceId: string): Promise<void> {
  try {
    await api.removeDevice(deviceId);
  } catch (e) {
    if (isAppError(e) && e.code === 'not_found') return;
    throw e;
  }
}
