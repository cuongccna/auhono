// Gốc ứng dụng: theme + thông báo nổi + định tuyến + thanh điều hướng dưới đáy.
import { useEffect, useState } from 'react';
import { App, AnimationRoutes, BottomNavigation, Icon, Route, SnackbarProvider, ZMPRouter, useLocation, useNavigate } from 'zmp-ui';
import ActivatePage from '../pages/activate.tsx';
import DevicePage from '../pages/device.tsx';
import HomePage from '../pages/home.tsx';
import RecipientsPage from '../pages/recipients.tsx';
import RenamePage from '../pages/rename.tsx';
import ThresholdsPage from '../pages/thresholds.tsx';
import { isZaloDarkTheme } from '../sdk.ts';
import { ErrorBoundary } from './error-boundary.tsx';

/** Thanh điều hướng chỉ hiện ở 2 màn hình gốc; các màn hình con có nút quay lại. */
function Nav() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  if (pathname !== '/' && pathname !== '/activate') return null;
  return (
    <BottomNavigation fixed activeKey={pathname} onChange={(key) => navigate(key, { animate: false })}>
      <BottomNavigation.Item itemKey="/" key="/" label="Thiết bị" icon={<Icon icon="zi-home" />} activeIcon={<Icon icon="zi-home" />} />
      <BottomNavigation.Item itemKey="/activate" key="/activate" label="Kích hoạt" icon={<Icon icon="zi-plus-circle" />} activeIcon={<Icon icon="zi-plus-circle-solid" />} />
    </BottomNavigation>
  );
}

/**
 * Chế độ tối: theo Zalo (`getSystemInfo().zaloTheme`) hoặc theo hệ thống (prefers-color-scheme).
 * Đặt data-auh-theme cho CSS của app và `theme` cho zmp-ui. CHƯA kiểm chứng trong Zalo thật.
 */
function useDarkTheme(): boolean {
  const query = () => (typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null);
  const [dark, setDark] = useState(() => isZaloDarkTheme() || !!query()?.matches);
  useEffect(() => {
    const mq = query();
    const update = () => setDark(isZaloDarkTheme() || !!mq?.matches);
    mq?.addEventListener?.('change', update);
    return () => mq?.removeEventListener?.('change', update);
  }, []);
  useEffect(() => {
    document.documentElement.setAttribute('data-auh-theme', dark ? 'dark' : 'light');
  }, [dark]);
  return dark;
}

export default function Root() {
  const dark = useDarkTheme();
  return (
    <App key={dark ? 'dark' : 'light'} theme={dark ? 'dark' : 'light'}>
      <SnackbarProvider>
        <ZMPRouter>
          <ErrorBoundary>
            <AnimationRoutes>
              <Route path="/" element={<HomePage />} />
              <Route path="/activate" element={<ActivatePage />} />
              <Route path="/device/:id" element={<DevicePage />} />
              <Route path="/device/:id/thresholds" element={<ThresholdsPage />} />
              <Route path="/device/:id/recipients" element={<RecipientsPage />} />
              <Route path="/device/:id/rename" element={<RenamePage />} />
            </AnimationRoutes>
          </ErrorBoundary>
          <Nav />
        </ZMPRouter>
      </SnackbarProvider>
    </App>
  );
}
