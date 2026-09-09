import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import LoginPage from './pages/LoginPage';
import SetupPage from './pages/SetupPage';
import DashboardLayout from './components/DashboardLayout';
import OverviewPage from './pages/OverviewPage';
import DevicesPage from './pages/DevicesPage';
import DeviceDetailPage from './pages/DeviceDetailPage';
import AuditPage from './pages/AuditPage';
import EnrollPage from './pages/EnrollPage';
import EnrollDevicePage from './pages/EnrollDevicePage';
import MapPage from './pages/MapPage';
import HealthPage from './pages/HealthPage';
import AdminsPage from './pages/AdminsPage';
import AlertsPage from './pages/AlertsPage';
import PblDevicesPage from './pages/PblDevicesPage';
import PblDeviceDetailPage from './pages/PblDeviceDetailPage';
import PblPolicyPage from './pages/PblPolicyPage';
import RequireRole from './components/RequireRole';

function PrivateRoute({ children }) {
  return localStorage.getItem('token') ? children : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <PrivateRoute>
            <DashboardLayout />
          </PrivateRoute>
        }
      >
        <Route index element={<OverviewPage />} />
        <Route path="devices" element={<DevicesPage />} />
        <Route path="devices/:id" element={<DeviceDetailPage />} />
        <Route path="devices/enroll" element={<RequireRole role="operator"><EnrollDevicePage /></RequireRole>} />
        <Route path="devices/enroll/manual" element={<RequireRole role="operator"><EnrollPage /></RequireRole>} />
        <Route path="map" element={<MapPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="health" element={<HealthPage />} />
        <Route path="alerts" element={<AlertsPage />} />
        <Route path="pbl-devices" element={<RequireRole role="operator"><PblDevicesPage /></RequireRole>} />
        <Route path="pbl-devices/:id" element={<RequireRole role="operator"><PblDeviceDetailPage /></RequireRole>} />
        <Route path="pbl-policy" element={<RequireRole role="super-admin"><PblPolicyPage /></RequireRole>} />
        <Route path="admins" element={<RequireRole role="super-admin"><AdminsPage /></RequireRole>} />
      </Route>
    </Routes>
  );
}
