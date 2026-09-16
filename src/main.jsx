import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';

const isPublicRoute = window.location.pathname !== '/';
const RouteApp = lazy(() => isPublicRoute ? import('./PublicCheckIn.jsx') : import('./DashboardRoot.jsx'));
document.querySelector('meta[name="theme-color"]')?.setAttribute('content', isPublicRoute ? '#153d2c' : '#f4f6f3');

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Suspense fallback={<main className="route-loading"><img src="/brand/logo.svg" alt={import.meta.env.VITE_ORGANIZATION_NAME || 'Seating Studio'} width="64" height="64" /><span>Opening secure check-in…</span></main>}><RouteApp /></Suspense>
  </React.StrictMode>
);
