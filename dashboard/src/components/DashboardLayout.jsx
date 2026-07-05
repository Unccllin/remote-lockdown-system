import React from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { ShieldAlert, Monitor, ClipboardList, LogOut, Plus } from 'lucide-react';

export default function DashboardLayout() {
  const navigate = useNavigate();

  function logout() {
    localStorage.removeItem('token');
    navigate('/login');
  }

  const navItem = ({ isActive }) =>
    `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
      isActive ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'
    }`;

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="w-60 bg-slate-900 border-r border-slate-800 flex flex-col shrink-0">
        <div className="p-5 border-b border-slate-800 flex items-center gap-3">
          <ShieldAlert className="text-blue-500" size={24} />
          <span className="font-bold text-sm tracking-wide text-slate-100">DeviceLock Admin</span>
        </div>

        <nav className="flex-1 p-4 space-y-1">
          <NavLink to="/devices" className={navItem}>
            <Monitor size={16} />
            Devices
          </NavLink>
          <NavLink to="/devices/enroll" className={navItem}>
            <Plus size={16} />
            Enroll Device
          </NavLink>
          <NavLink to="/audit" className={navItem}>
            <ClipboardList size={16} />
            Audit Log
          </NavLink>
        </nav>

        <div className="p-4 border-t border-slate-800">
          <button onClick={logout} className="flex items-center gap-2 text-slate-400 hover:text-red-400 text-sm w-full">
            <LogOut size={16} />
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto bg-slate-950 p-8">
        <Outlet />
      </main>
    </div>
  );
}
