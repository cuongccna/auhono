// Chuẩn hóa chuỗi do người dùng gõ/dán (tên tủ, tên người nhận, số, mã).
// Bàn phím iOS/Android có thể gửi chữ Việt ở dạng tổ hợp (NFD: "e" + dấu) thay vì dạng dựng sẵn (NFC);
// server KHÔNG chuẩn hóa nên ta đưa về NFC trước khi đếm ký tự và trước khi gửi.

/** Ký tự điều khiển, ký tự vô hình (zero-width) và ký tự đổi chiều chữ (bidi) — thường do dán từ tin nhắn/web. */
// Giữ ZWJ/ZWNJ (U+200C/U+200D) nằm GIỮA hai ký tự vì emoji ghép và một số chữ cần chúng; chỉ bỏ khi đứng đầu/cuối/cạnh dấu cách (xem cleanText).
const INVISIBLE_RE = /[\u0000-\u001F\u007F-\u009F­​‎‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** Server giới hạn tên tối đa 60 ký tự, đếm theo đơn vị UTF-16 của JavaScript (biểu tượng cảm xúc = 2). */
export const NAME_MAX = 60;

/** Bỏ nửa cặp surrogate lẻ (do cắt chuỗi giữa emoji), giữ nguyên cặp đúng. Không dùng lookbehind (WebView cũ). */
function dropLoneSurrogates(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i]! + s[i + 1]!;
        i++;
      }
    } else if (c < 0xdc00 || c > 0xdfff) {
      out += s[i]!;
    }
  }
  return out;
}

/** NFC + gộp mọi khoảng trắng/xuống dòng thành 1 dấu cách + bỏ ký tự vô hình + cắt đầu/cuối. */
export function cleanText(raw: string): string {
  return dropLoneSurrogates(raw.normalize('NFC'))
    .replace(/\s+/g, ' ')
    .replace(INVISIBLE_RE, '')
    .replace(/(^|\s)[\u200C\u200D]+|[\u200C\u200D]+(?=$|\s)/g, '$1') // ZWJ/ZWNJ lẻ loi
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** Đưa chữ/số toàn chiều rộng ("１２３", "Ａ") và các dạng tương thích về ASCII (NFKC) cho ô số/mã. */
export function foldWidth(raw: string): string {
  return raw.normalize('NFKC');
}

export type NameResult = { ok: true; value: string } | { ok: false; error: string };

/** Kiểm tra tên (tủ / người nhận): sau khi chuẩn hóa phải 1..60 ký tự. `emptyMessage` là câu hướng dẫn khi để trống. */
export function validateName(raw: string, emptyMessage: string): NameResult {
  const value = cleanText(raw);
  if (value.length === 0) return { ok: false, error: emptyMessage };
  if (value.length > NAME_MAX) {
    return { ok: false, error: `Tên tối đa ${NAME_MAX} ký tự (mỗi biểu tượng cảm xúc tính 2 ký tự).` };
  }
  return { ok: true, value };
}
