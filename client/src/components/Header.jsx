import React from 'react';
import { Link, NavLink } from 'react-router-dom';
import { App as AntdApp } from 'antd';
export function Header({ session }) {
  const canSeeTeacher = (session?.userPermission ?? 0) >= 4 || session?.isOwner;
  const { modal } = AntdApp.useApp();

  const onLogout = (e) => {
    e.preventDefault();
    modal.confirm({
      title: 'Log out?',
      content: 'Do you want to log out?',
      okText: 'Log out',
      cancelText: 'Cancel',
      onOk: () => { window.location.href = '/logout'; },
    });
  };

  const linkClass = ({ isActive }) => (isActive ? 'active' : '');

  return (
    <header>
      <div className="logo">
        <Link to="/app/player">Jukebar</Link>
      </div>
      <ul className="nav-links">
        {canSeeTeacher && (
          <li><NavLink to="/app/teacher" className={linkClass}>Teacher</NavLink></li>
        )}
        <li><NavLink to="/app/player" className={linkClass}>Player</NavLink></li>
        <li><NavLink to="/app/leaderboard" className={linkClass}>Leaderboard</NavLink></li>
        <li className="logout-link"><a href="/logout" onClick={onLogout}>Logout</a></li>
      </ul>
    </header>
  );
}
