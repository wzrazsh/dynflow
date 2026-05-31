import { useState, useCallback } from 'react';
import WorkflowList from './components/WorkflowList';
import CreateWorkflowForm from './components/CreateWorkflowForm';
import WorkflowDetail from './components/WorkflowDetail';
import ErrorBoundary from './components/ErrorBoundary';
import Toast from './components/Toast';
import AgentPicker from './components/AgentPicker';
import SkillPicker from './components/SkillPicker';
import TemplateList from './components/TemplateList';
import TemplateDetail from './components/TemplateDetail';
import TemplateForm from './components/TemplateForm';
import type { WorkflowTemplate } from '@dynflow/shared';

type View = 'list' | 'detail' | 'create' | 'agents' | 'skills' | 'templates' | 'template-detail';

export default function App() {
  const [view, setView] = useState<View>('list');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [showTemplateForm, setShowTemplateForm] = useState(false);
  const [templateToEdit, setTemplateToEdit] = useState<WorkflowTemplate | undefined>(undefined);
  const [templateListKey, setTemplateListKey] = useState(0);
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
              <button
                onClick={() => setView('templates')}
                style={{
                  padding: '8px 20px',
                  backgroundColor: '#10b981',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Templates
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

        {view === 'templates' && (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
              <button
                onClick={() => setView('list')}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#3b82f6',
                  cursor: 'pointer',
                  padding: 0,
                  fontSize: '0.875rem',
                }}
              >
                &larr; Back to list
              </button>
              <button
                onClick={() => {
                  setTemplateToEdit(undefined);
                  setShowTemplateForm(true);
                }}
                style={{
                  padding: '8px 20px',
                  backgroundColor: '#3b82f6',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  marginLeft: 'auto',
                }}
              >
                + New Template
              </button>
            </div>
            <div style={{ display: 'flex', gap: 16 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <TemplateList
                  key={templateListKey}
                  selectedId={selectedTemplateId}
                  onSelect={(id) => setSelectedTemplateId(id)}
                  onError={showError}
                />
              </div>
              {selectedTemplateId && (
                <div style={{ flex: 2, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <div style={{ textAlign: 'right', marginBottom: 8 }}>
                    <button
                      onClick={() => setView('template-detail')}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#3b82f6',
                        cursor: 'pointer',
                        fontSize: '0.8rem',
                      }}
                    >
                      Full view &rarr;
                    </button>
                  </div>
                  <TemplateDetail
                    templateId={selectedTemplateId}
                    onBack={() => setSelectedTemplateId(null)}
                    onEdit={(t) => {
                      setTemplateToEdit(t);
                      setShowTemplateForm(true);
                    }}
                    onError={showError}
                    onSuccess={showSuccess}
                  />
                </div>
              )}
            </div>
          </>
        )}

        {view === 'template-detail' && selectedTemplateId && (
          <TemplateDetail
            templateId={selectedTemplateId}
            onBack={() => {
              setSelectedTemplateId(null);
              setView('templates');
            }}
            onEdit={(t) => {
              setTemplateToEdit(t);
              setShowTemplateForm(true);
            }}
            onError={showError}
            onSuccess={showSuccess}
          />
        )}

        {showTemplateForm && (
          <TemplateForm
            template={templateToEdit}
            onClose={() => {
              setShowTemplateForm(false);
              setTemplateToEdit(undefined);
            }}
            onSaved={(template) => {
              setShowTemplateForm(false);
              setTemplateToEdit(undefined);
              setSelectedTemplateId(template.id);
              setTemplateListKey((k) => k + 1);
              showSuccess('Template saved successfully');
            }}
            onError={showError}
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
