import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search, Bell, ChevronDown, LogOut, User, ShieldAlert,
} from 'lucide-react';
import { useCurrentUser } from '../hooks/useCurrentUser';
import { getUnreadAlertCount } from '../api/alerts';

const ROLE_LABEL = {
  viewer: 'Viewer',
  operator: 'Operator',
  'super-admin': 'Super Admin',
};

/**
 * FleetGuard Top Bar — persistent command-center header.
 * Contains: global search, notification bell with unread count,
 * admin profile chip with dropdown.
 */
export default function TopBar() {
  const navigate = useNavigate();
  const currentUser = useCurrentUser();
  const [search, setSearch] = useState('');
  const [alertCount, setAlertCount] = useState(0);
  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef(null);

  useEffect(() => {
    getUnreadAlertCount().then(setAlertCount).catch(() => {});
    // Refresh count every 60s
    const interval = setInterval(() => {
      getUnreadAlertCount().then(setAlertCount).catch(() => {});
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  // Close profile dropdown on outside click
  useEffect(() => {
    function handleClick(e) {
      if (profileRef.current && !profileRef.current.contains(e.target)) {
        setProfileOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  function handleSearch(e) {
    e.preventDefault();
    if (search.trim()) {
      navigate(`/devices?q=${encodeURIComponent(search.trim())}`);
      setSearch('');
    }
  }

  function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    navigate('/login');
  }

  return (
    <header className="flex items-center gap-3 px-4 py-3 border-b border-slate-800/60 bg-slate-900/80 backdrop-blur-xl shrink-0 z-30">
      {/* Search */}
      <form onSubmit={handleSearch} className="relative flex-1 max-w-md">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
        <input
          className="input pl-10 h-9 text-sm focus:max-w-md transition-all"
          placeholder="Search devices by hostname, owner, or ID…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </form>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Notification bell */}
      <button
        onClick={() => navigate('/alerts')}
        className="relative p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 transition-colors"
        title="Alerts"
      >
        <Bell size={18} />
        {alertCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] flex items-center justify-center text-[10px] font-bold text-white bg-red-500 rounded-full px-1 ring-2 ring-slate-900 animate-pulse">
            {alertCount > 99 ? '99+' : alertCount}
          </span>
        )}
      </button>

      {/* Admin profile chip */}
      <div ref={profileRef} className="relative">
        <button
          onClick={() => setProfileOpen(!profileOpen)}
          className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-800/60 transition-colors"
        >
          <div className="w-7 h-7 rounded-full bg-slate-700 flex items-center justify-center text-xs font-bold text-slate-200">
            {(currentUser?.username || '?').charAt(0).toUpperCase()}
          </div>
          <div className="hidden sm:block text-left">
            <div className="text-xs text-slate-200 font-medium leading-tight">
              {currentUser?.username || 'admin'}
            </div>
            <div className="text-[10px] text-slate-500 uppercase tracking-wider leading-tight">
              {ROLE_LABEL[currentUser?.role] || currentUser?.role || 'viewer'}
            </div>
          </div>
          <ChevronDown size={14} className="text-slate-500" />
        </button>

        {profileOpen && (
          <div className="absolute right-0 top-full mt-1 w-48 bg-slate-900/95 backdrop-blur-xl border border-slate-700/60 rounded-xl shadow-xl shadow-black/40 py-1 z-50">
            <div className="px-3 py-2 border-b border-slate-800/60">
              <div className="text-xs text-slate-300 font-medium">
                {currentUser?.username || 'admin'}
              </div>
              <div className="text-[10px] text-slate-500">
                {ROLE_LABEL[currentUser?.role] || currentUser?.role || 'viewer'}
              </div>
            </div>
            <button
              onClick={logout}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-400 hover:text-red-400 hover:bg-red-500/5 transition-colors"
            >
              <LogOut size={14} />
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
