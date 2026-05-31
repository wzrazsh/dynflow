import { useState, useCallback } from 'react';
import WorkflowList from './components/WorkflowList';
import CreateWorkflowForm from './components/CreateWorkflowForm';
import WorkflowDetail from './components/WorkflowDetail';
import ErrorBoundary from './components/ErrorBoundary';
import Toast from './components/Toast';

type View = 'list' | 'detail' | 'create';

export default function App() {
  const [view, setView] = useState<View>('list');
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
                marginBottom: 16,
              }}
            >
              + New Workflow
            </button>
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
