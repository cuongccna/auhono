// Khung một màn hình: thanh tiêu đề (zmp-ui Header) + vùng nội dung có lề an toàn.
import type { ReactNode } from 'react';
import { Header, Page } from 'zmp-ui';

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
  return (
    <Page className="auh-page">
      <Header title={title} showBackIcon={back} />
      <main className={withNav ? 'auh-main auh-with-nav' : 'auh-main'}>{children}</main>
    </Page>
  );
}
