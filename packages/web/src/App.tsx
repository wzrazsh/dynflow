import { useState, useCallback } from 'react';
import WorkflowList from './components/WorkflowList';
import CreateWorkflowForm from './components/CreateWorkflowForm';
import WorkflowDetail from './components/WorkflowDetail';
import ErrorBoundary from './components/ErrorBoundary';
import Toast from './components/Toast';
import AgentPicker from './components/AgentPicker';
import SkillPicker from './components/SkillPicker';

type View = 'list' | 'detail' | 'create' | 'agents' | 'skills';

export default function App() {
  const [view, setView] = useState<View>('list');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [toast, setToast] = useState<{
    message: string;
    type: 'error' | 'info' | 'success';
  } | null>(null);

  const showError = useCallback((message: string) => {
    setToast({ message, type: 'error' });
  }, []);

  const showSuccess = useCallback((message: string) => {
    setToast({ message, type: 'success' });
  }, []);

  const clearToast = useCallback(() => {
    setToast(null);
  }, []);

  return (
    <ErrorBoundary>
      <div style={{ maxWidth: 800, margin: '0 auto', padding: 20 }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: 20 }}>
          DynFlow
        </h1>

        {view === 'list' && (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <button
                onClick={() => setView('agents')}
                style={{
                  padding: '8px 20px',
                  backgroundColor: '#3b82f6',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Browse Agents
              </button>
              <button
                onClick={() => setView('skills')}
                style={{
                  padding: '8px 20px',
                  backgroundColor: '#3b82f6',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Browse Skills
              </button>
              <button
                onClick={() => setView('create')}
                style={{
                  padding: '8px 20px',
                  backgroundColor: '#3b82f6',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                + New Workflow
              </button>
            </div>
            <WorkflowList
              onSelect={(id) => {
                setSelectedId(id);
                setView('detail');
              }}
              onError={showError}
            />
          </>
        )}

        {view === 'create' && (
          <CreateWorkflowForm
            onBack={() => setView('list')}
            onCreated={() => {
              setView('list');
              showSuccess('Workflow created successfully');
            }}
          />
        )}

        {view === 'detail' && selectedId && (
          <WorkflowDetail
            workflowId={selectedId}
            onBack={() => setView('list')}
          />
        )}

        {view === 'agents' && (
          <>
            <button
              onClick={() => setView('list')}
              style={{
                background: 'none',
                border: 'none',
                color: '#3b82f6',
                cursor: 'pointer',
                padding: 0,
                marginBottom: 16,
                fontSize: '0.875rem',
              }}
            >
              &larr; Back to list
            </button>
            <AgentPicker
              selectedAgents={selectedAgents}
              onSelectionChange={setSelectedAgents}
            />
          </>
        )}

        {view === 'skills' && (
          <>
            <button
              onClick={() => setView('list')}
              style={{
                background: 'none',
                border: 'none',
                color: '#3b82f6',
                cursor: 'pointer',
                padding: 0,
                marginBottom: 16,
                fontSize: '0.875rem',
              }}
            >
              &larr; Back to list
            </button>
            <SkillPicker
              selectedSkills={selectedSkills}
              onSelectionChange={setSelectedSkills}
            />
          </>
        )}

        {toast && (
          <Toast
            message={toast.message}
            type={toast.type}
            onClose={clearToast}
          />
        )}
      </div>
    </ErrorBoundary>
  );
}
