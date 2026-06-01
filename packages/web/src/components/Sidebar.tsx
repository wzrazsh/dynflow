import type { View } from '../App';

interface MenuItem {
  label: string;
  icon: string;
  view: View;
}

interface MenuGroup {
  title: string;
  items: MenuItem[];
}

const menuGroups: MenuGroup[] = [
  {
    title: 'WORKFLOWS',
    items: [
      { label: 'All Workflows', icon: '⚡', view: 'list' },
      { label: '+ New Workflow', icon: '✚', view: 'create' },
    ],
  },
  {
    title: 'LIBRARY',
    items: [
      { label: 'Templates', icon: '📋', view: 'templates' },
      { label: 'Agents', icon: '🤖', view: 'agents' },
      { label: 'Skills', icon: '🧠', view: 'skills' },
    ],
  },
  {
    title: 'TOOLS',
    items: [
      { label: 'Projects', icon: '📁', view: 'projects' },
      { label: 'Import from GitHub', icon: '⬇', view: 'meta' },
    ],
  },
];

const ACCENT_COLORS: Record<string, string> = {
  templates: '#10b981',
  agents: '#3b82f6',
  skills: '#3b82f6',
  projects: '#0891b2',
  meta: '#8b5cf6',
};

export default function Sidebar({
  currentView,
  onNavigate,
}: {
  currentView: View;
  onNavigate: (view: View) => void;
}) {
  return (
    <aside
      aria-label="Main navigation"
      style={{
        width: 240,
        minWidth: 240,
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#1e293b',
        color: '#e2e8f0',
        overflowY: 'auto',
        borderRight: '1px solid #334155',
      }}
    >
      {/* Logo */}
      <div
        style={{
          padding: '20px 20px 16px',
          borderBottom: '1px solid #334155',
        }}
      >
        <div
          style={{
            fontSize: '1.25rem',
            fontWeight: 700,
            color: '#f8fafc',
            letterSpacing: '0.02em',
          }}
        >
          DynFlow
        </div>
        <div
          style={{
            fontSize: '0.65rem',
            color: '#64748b',
            marginTop: 2,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          Workflow Orchestration
        </div>
      </div>

      {/* Navigation */}
      <nav style={{ flex: 1, padding: '12px 0' }}>
        {menuGroups.map((group) => (
          <div key={group.title} style={{ marginBottom: 8 }}>
            <div
              style={{
                padding: '8px 20px 6px',
                fontSize: '0.65rem',
                fontWeight: 600,
                color: '#64748b',
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
              }}
            >
              {group.title}
            </div>
            {group.items.map((item) => {
              const isActive = currentView === item.view;
              const accentColor =
                ACCENT_COLORS[item.view] || '#3b82f6';
              return (
                <button
                  key={item.view}
                  onClick={() => onNavigate(item.view)}
                  aria-label={item.label}
                  aria-current={isActive ? 'page' : undefined}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    width: '100%',
                    padding: '8px 20px',
                    paddingLeft: isActive ? 17 : 20,
                    border: 'none',
                    borderLeft: isActive
                      ? `3px solid ${accentColor}`
                      : '3px solid transparent',
                    backgroundColor: isActive
                      ? 'rgba(59, 130, 246, 0.1)'
                      : 'transparent',
                    color: isActive ? '#f8fafc' : '#94a3b8',
                    fontSize: '0.8125rem',
                    fontWeight: isActive ? 600 : 400,
                    cursor: 'pointer',
                    textAlign: 'left',
                    lineHeight: 1.4,
                    transition: 'all 0.15s ease',
                    height: 40,
                    boxSizing: 'border-box',
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.backgroundColor =
                        'rgba(255, 255, 255, 0.04)';
                      e.currentTarget.style.color = '#e2e8f0';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.backgroundColor =
                        'transparent';
                      e.currentTarget.style.color = '#94a3b8';
                    }
                  }}
                >
                  <span style={{ fontSize: '0.9375rem', lineHeight: 1 }}>
                    {item.icon}
                  </span>
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div
        style={{
          padding: '12px 20px',
          borderTop: '1px solid #334155',
          fontSize: '0.6875rem',
          color: '#475569',
          textAlign: 'center',
        }}
      >
        DynFlow v0.2.0
      </div>
    </aside>
  );
}
