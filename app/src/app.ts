// Điểm vào của Mini App (theo cấu trúc zmp-cli).
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import 'zmp-ui/zaui.css';
import './css/app.css';
import Root from './components/app.tsx';

createRoot(document.getElementById('app')!).render(createElement(Root));
