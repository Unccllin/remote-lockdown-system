import React, { useState, useEffect } from 'react';
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
  ShieldAlert, Monitor, ClipboardList, LogOut, Plus, Map as MapIcon,
  LayoutDashboard, Menu, X, Activity,
} from 'lucide-react';

export default function DashboardLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  function logout() {
    localStorage.removeItem('token');
    navigate('/login');
  }

  // Close sidebar on route change (mobile)
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  const navItems = [
    { to: '/', icon: LayoutDashboard, label: 'Overview', end: true },
    { to: '/devices', icon: Monitor, label: 'Devices' },
    { to: '/map', icon: MapIcon, label: 'Map View' },
    { to: '/devices/enroll', icon: Plus, label: 'Enroll Device' },
    { to: '/audit', icon: ClipboardList, label: 'Audit Log' },
  ];

  const navItemClass = ({ isActive }) =>
    `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 ${
      isActive
        ? 'bg-blue-600/15 text-blue-400 border border-blue-500/20'
        : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-100 border border-transparent'
    }`;

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 lg:hidden backdrop-blur-sm"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-40 w-64 bg-slate-900/80 backdrop-blur-xl border-r border-slate-800/60 flex flex-col shrink-0 transition-transform duration-300 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
      >
        {/* Logo */}
        <div className="p-5 border-b border-slate-800/60 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="absolute inset-0 bg-blue-500/30 blur-xl rounded-lg" />
              <ShieldAlert className="relative text-blue-500" size={24} />
            </div>
            <div>
              <div className="font-bold text-sm tracking-wide text-slate-100">DeviceLock</div>
              <div className="text-[10px] text-slate-500 tracking-wider uppercase">Admin Console</div>
            </div>
          </div>
          <button className="lg:hidden text-slate-400" onClick={() => setSidebarOpen(false)}>
            <X size={18} />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-4 space-y-1">
          {navItems.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={navItemClass}>
              <item.icon size={16} />
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* System status indicator */}
        <div className="px-4 pb-2">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800/40 border border-slate-700/30">
            <div className="relative">
              <div className="w-2 h-2 rounded-full bg-emerald-500" />
              <div className="absolute inset-0 w-2 h-2 rounded-full bg-emerald-500 pulse-ring" />
            </div>
            <span className="text-xs text-slate-400">System Online</span>
            <Activity size={12} className="text-emerald-500/50 ml-auto" />
          </div>
        </div>

        {/* Logout */}
        <div className="p-4 border-t border-slate-800/60">
          <button
            onClick={logout}
            className="flex items-center gap-2 text-slate-400 hover:text-red-400 text-sm w-full transition-colors px-3 py-2 rounded-lg hover:bg-red-500/5"
          >
            <LogOut size={16} />
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile header */}
        <div className="lg:hidden flex items-center justify-between px-4 py-3 border-b border-slate-800/60 bg-slate-900/80 backdrop-blur-xl">
          <div className="flex items-center gap-2">
            <ShieldAlert className="text-blue-500" size={20} />
            <span className="font-bold text-sm text-slate-100">DeviceLock</span>
          </div>
          <button className="text-slate-400" onClick={() => setSidebarOpen(true)}>
            <Menu size={20} />
          </button>
        </div>

        <main className="flex-1 overflow-y-auto p-6 lg:p-8">
          <div className="animate-fade-in">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
