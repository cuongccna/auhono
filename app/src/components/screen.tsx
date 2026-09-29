// Khung một màn hình: thanh tiêu đề (zmp-ui Header) + vùng nội dung có lề an toàn + báo khi điện thoại mất mạng.
import type { ReactNode } from 'react';
import { Header, Page } from 'zmp-ui';
import { useOnline } from '../hooks.ts';

export function Screen({
  title,
  back = true,
  withNav = false,
  children,
}: {
  title: string;
  back?: boolean;
  /** true nếu có thanh điều hướng dưới đáy (chừa chỗ). */
  withNav?: boolean;
  children: ReactNode;
}) {
  const online = useOnline();
  return (
    <Page className="auh-page">
      <Header title={title} showBackIcon={back} />
      <main className={withNav ? 'auh-main auh-with-nav' : 'auh-main'}>
        {!online && (
          <div className="auh-banner auh-banner-warn" role="status">
            Điện thoại đang không có mạng. Số liệu bạn thấy có thể đã cũ. Bật Wi-Fi hoặc 4G để cập nhật.
          </div>
        )}
        {children}
      </main>
    </Page>
  );
}
