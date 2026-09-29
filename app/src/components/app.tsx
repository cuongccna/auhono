// Gốc ứng dụng: theme + thông báo nổi + định tuyến + thanh điều hướng dưới đáy.
import { App, AnimationRoutes, BottomNavigation, Icon, Route, SnackbarProvider, ZMPRouter, useLocation, useNavigate } from 'zmp-ui';
import ActivatePage from '../pages/activate.tsx';
import DevicePage from '../pages/device.tsx';
import HomePage from '../pages/home.tsx';
import RecipientsPage from '../pages/recipients.tsx';
import ThresholdsPage from '../pages/thresholds.tsx';

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

export default function Root() {
  return (
    <App>
      <SnackbarProvider>
        <ZMPRouter>
          <AnimationRoutes>
            <Route path="/" element={<HomePage />} />
            <Route path="/activate" element={<ActivatePage />} />
            <Route path="/device/:id" element={<DevicePage />} />
            <Route path="/device/:id/thresholds" element={<ThresholdsPage />} />
            <Route path="/device/:id/recipients" element={<RecipientsPage />} />
          </AnimationRoutes>
          <Nav />
        </ZMPRouter>
      </SnackbarProvider>
    </App>
  );
}
