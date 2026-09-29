// Dòng "Nhận thêm qua Telegram (miễn phí)" của một người nhận: chưa kết nối / đang có liên kết chờ / đã kết nối (chọn kênh, ngắt).
// Chỉ trình bày; mọi thao tác gọi API nằm ở trang người nhận (có chống bấm đúp).
import { useState } from 'react';
import { nowSeconds } from '../hooks.ts';
import { formatUntil } from '../lib/alert-actions.ts';
import type { Recipient } from '../lib/schemas.ts';
import { LINK_ONE_TIME_NOTE, MODE_LABEL, MODE_ORDER, shareMessage, type RecipientMode } from '../lib/telegram.ts';
import { copyText, openTelegramLink, shareText } from '../sdk.ts';

export interface PendingLink {
  url: string;
  /** Unix giây (giờ server) hoặc undefined. */
  expiresAt?: number;
}

/** Bảng liên kết vừa tạo: mở trên máy này / chia sẻ / sao chép. Liên kết phải được mở trên điện thoại của NGƯỜI NHẬN. */
function LinkPanel({ recipient, link, onRefresh, onClose }: { recipient: Recipient; link: PendingLink; onRefresh: () => void; onClose: () => void }) {
  const [note, setNote] = useState<string | null>(null);

  async function open() {
    setNote((await openTelegramLink(link.url)) ? 'Đã mở Telegram. Bấm Start trong Telegram rồi quay lại đây.' : 'Không mở được Telegram tự động. Hãy sao chép liên kết bên dưới và mở thủ công.');
  }
  async function copy() {
    setNote((await copyText(link.url)) ? 'Đã sao chép liên kết.' : 'Không sao chép được. Hãy bấm giữ vào liên kết để chọn và sao chép.');
  }
  async function share() {
    if (await shareText(shareMessage(recipient.name, link.url))) return setNote(null);
    // Không có bảng chia sẻ (hoặc người dùng huỷ): chép lời nhắn để dán vào Zalo/tin nhắn.
    setNote((await copyText(shareMessage(recipient.name, link.url))) ? 'Đã sao chép lời nhắn kèm liên kết. Hãy dán và gửi cho người nhận.' : 'Không chia sẻ được. Hãy sao chép liên kết bên dưới.');
  }

  return (
    <div className="auh-banner auh-banner-info" role="group" aria-label={`Liên kết Telegram cho ${recipient.name}`} style={{ marginTop: 12, marginBottom: 0 }}>
      <strong>Liên kết Telegram cho {recipient.name}</strong>
      <p style={{ margin: '4px 0' }}>
        Liên kết phải được mở trên điện thoại của <strong>chính {recipient.name}</strong>. Nếu đó là người khác, bấm "Chia sẻ liên kết" để gửi cho họ.{' '}
        {LINK_ONE_TIME_NOTE}
        {link.expiresAt ? ` Hết hạn lúc ${formatUntil(link.expiresAt, nowSeconds())}.` : ''}
      </p>
      <code className="auh-code" data-testid="telegram-link">{link.url}</code>
      <div className="auh-stack" style={{ marginTop: 12 }}>
        <button type="button" className="auh-btn" onClick={() => void share()}>Chia sẻ liên kết</button>
        <button type="button" className="auh-btn auh-btn-secondary" onClick={() => void copy()}>Sao chép liên kết</button>
        <button type="button" className="auh-btn auh-btn-secondary" onClick={() => void open()}>Mở Telegram trên máy này</button>
      </div>
      {note && <p role="status" style={{ margin: '8px 0 0' }}>{note}</p>}
      <p className="auh-help" style={{ color: 'inherit' }}>Mở Telegram, bấm Start. Sau đó quay lại đây và làm mới.</p>
      <div className="auh-stack">
        <button type="button" className="auh-btn auh-btn-secondary" onClick={onRefresh}>Làm mới</button>
        <button type="button" className="auh-btn auh-btn-secondary" onClick={onClose}>Đóng</button>
      </div>
    </div>
  );
}

export interface TelegramRowProps {
  recipient: Recipient;
  link: PendingLink | null;
  busy: boolean;
  onCreateLink: () => void;
  onSetMode: (mode: RecipientMode) => void;
  onUnlink: () => void;
  onRefresh: () => void;
  onCloseLink: () => void;
}

export function TelegramRow({ recipient, link, busy, onCreateLink, onSetMode, onUnlink, onRefresh, onCloseLink }: TelegramRowProps) {
  const linked = recipient.telegram_linked === true;
  return (
    <div className="auh-telegram">
      <div className="auh-row-between auh-wrap">
        <span className="auh-muted" style={{ margin: 0 }}>Nhận thêm qua Telegram (miễn phí)</span>
        {linked && <span className="auh-tag">Đã kết nối Telegram</span>}
      </div>

      {!linked && !link && (
        <button type="button" className="auh-btn auh-btn-secondary" style={{ marginTop: 8 }} onClick={onCreateLink} disabled={busy}>
          {busy ? 'Đang xử lý...' : 'Kết nối Telegram'}
        </button>
      )}
      {!linked && link && <LinkPanel recipient={recipient} link={link} onRefresh={onRefresh} onClose={onCloseLink} />}

      {linked && (
        <>
          <div className="auh-modes" role="group" aria-label={`Kênh nhận tin của ${recipient.name}`}>
            {MODE_ORDER.map((m) => (
              <button key={m} type="button" className="auh-choice auh-mode" aria-pressed={recipient.mode === m} disabled={busy} onClick={() => recipient.mode !== m && onSetMode(m)}>
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
          <button type="button" className="auh-btn auh-btn-danger" style={{ marginTop: 8 }} onClick={onUnlink} disabled={busy}>
            Ngắt kết nối
          </button>
        </>
      )}
    </div>
  );
}
