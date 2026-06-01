import { type ReactNode } from 'react';
import Sidebar from './Sidebar';
import type { View } from '../App';

export default function Layout({
  currentView,
  onNavigate,
  children,
}: {
  currentView: View;
  onNavigate: (view: View) => void;
  children: ReactNode;
}) {
  return (
    <>
      <style>{`
        .layout-root {
          display: flex;
          min-height: 100vh;
        }
        .layout-main {
          flex: 1;
          min-width: 0;
          background-color: #f9fafb;
          padding: 32px;
          overflow-y: auto;
        }
        @media (max-width: 767px) {
          .layout-root {
            flex-direction: column;
          }
          .layout-sidebar-desktop {
            display: none !important;
          }
        }
        @media (min-width: 768px) {
          .layout-sidebar-mobile {
            display: none !important;
          }
        }
      `}</style>
      <div className="layout-root">
        {/* Desktop sidebar */}
        <div className="layout-sidebar-desktop">
          <Sidebar currentView={currentView} onNavigate={onNavigate} />
        </div>

        {/* Mobile horizontal nav */}
        <div className="layout-sidebar-mobile">
          <MobileTopBar
            currentView={currentView}
            onNavigate={onNavigate}
          />
        </div>

        <main className="layout-main" role="main">
          {children}
        </main>
      </div>
    </>
  );
}

function MobileTopBar({
  currentView,
  onNavigate,
}: {
  currentView: View;
  onNavigate: (view: View) => void;
}) {
  const items: { label: string; view: View }[] = [
    { label: 'Workflows', view: 'list' },
    { label: 'Templates', view: 'templates' },
    { label: 'Agents', view: 'agents' },
    { label: 'Skills', view: 'skills' },
    { label: 'Projects', view: 'projects' },
    { label: 'GitHub', view: 'meta' },
  ];

  return (
    <nav
      aria-label="Mobile navigation"
      style={{
        display: 'flex',
        overflowX: 'auto',
        backgroundColor: '#1e293b',
        borderBottom: '1px solid #334155',
        gap: 0,
      }}
    >
      <div
        style={{
          padding: '10px 14px',
          fontSize: '0.875rem',
          fontWeight: 700,
          color: '#f8fafc',
          whiteSpace: 'nowrap',
          borderRight: '1px solid #334155',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        DF
      </div>
      {items.map((item) => {
        const isActive = currentView === item.view;
        return (
          <button
            key={item.view}
            onClick={() => onNavigate(item.view)}
            aria-label={item.label}
            aria-current={isActive ? 'page' : undefined}
            style={{
              padding: '10px 12px',
              border: 'none',
              borderBottom: isActive ? '2px solid #3b82f6' : '2px solid transparent',
              backgroundColor: isActive ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
              color: isActive ? '#f8fafc' : '#94a3b8',
              fontSize: '0.75rem',
              fontWeight: isActive ? 600 : 400,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
