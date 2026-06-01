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
import TemplateVersionHistory from './components/TemplateVersionHistory';
import ImportExport from './components/ImportExport';
import MetaWorkflow from './components/MetaWorkflow';
import ProjectList from './components/ProjectList';
import ProjectDetail from './components/ProjectDetail';
import type { WorkflowTemplate } from '@dynflow/shared';

type View = 'list' | 'detail' | 'create' | 'agents' | 'skills' | 'templates' | 'template-detail' | 'meta' | 'projects' | 'project-detail';

export default function App() {
  const [view, setView] = useState<View>('list');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [showTemplateForm, setShowTemplateForm] = useState(false);
  const [templateToEdit, setTemplateToEdit] = useState<WorkflowTemplate | undefined>(undefined);
  const [templateListKey, setTemplateListKey] = useState(0);
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [showImportExport, setShowImportExport] = useState(false);
  const [selectedProjectName, setSelectedProjectName] = useState<string | null>(null);
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
              <button
                onClick={() => setView('meta')}
                style={{
                  padding: '8px 20px',
                  backgroundColor: '#8b5cf6',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Import from GitHub
              </button>
              <button
                onClick={() => setView('projects')}
                style={{
                  padding: '8px 20px',
                  backgroundColor: '#0891b2',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Projects
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
                    onDeleted={() => {
                      setSelectedTemplateId(null);
                      setTemplateListKey((k) => k + 1);
                    }}
                  />
                </div>
              )}
            </div>
          </>
        )}

        {view === 'template-detail' && selectedTemplateId && (
          <div>
            <TemplateDetail
              templateId={selectedTemplateId}
              onBack={() => {
                setSelectedTemplateId(null);
                setView('templates');
                setShowVersionHistory(false);
                setShowImportExport(false);
              }}
              onEdit={(t) => {
                setTemplateToEdit(t);
                setShowTemplateForm(true);
              }}
              onError={showError}
              onSuccess={showSuccess}
              onDeleted={() => {
                setSelectedTemplateId(null);
                setView('templates');
                setShowVersionHistory(false);
                setShowImportExport(false);
                setTemplateListKey((k) => k + 1);
              }}
            />
            
            {/* Additional Actions */}
            <div style={{ display: 'flex', gap: 8, marginTop: 16, marginBottom: 16 }}>
              <button
                onClick={() => {
                  setShowVersionHistory(!showVersionHistory);
                  setShowImportExport(false);
                }}
                style={{
                  padding: '6px 12px',
                  backgroundColor: showVersionHistory ? '#1976d2' : '#fff',
                  color: showVersionHistory ? '#fff' : '#374151',
                  border: '1px solid #d1d5db',
                  borderRadius: 4,
                  fontSize: '0.8125rem',
                  cursor: 'pointer',
                }}
              >
                Version History
              </button>
              <button
                onClick={() => {
                  setShowImportExport(!showImportExport);
                  setShowVersionHistory(false);
                }}
                style={{
                  padding: '6px 12px',
                  backgroundColor: showImportExport ? '#1976d2' : '#fff',
                  color: showImportExport ? '#fff' : '#374151',
                  border: '1px solid #d1d5db',
                  borderRadius: 4,
                  fontSize: '0.8125rem',
                  cursor: 'pointer',
                }}
              >
                Import/Export
              </button>
            </div>

            {/* Version History Panel */}
            {showVersionHistory && (
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, marginBottom: 16 }}>
                <TemplateVersionHistory
                  templateId={selectedTemplateId}
                  currentVersion={1}
                  onVersionSelect={(v) => console.log('Selected version:', v)}
                  onRollback={async (v) => {
                    try {
                      const { post } = await import('./api/client.js');
                      await post(`/templates/${selectedTemplateId}/rollback`, { version: v });
                      showSuccess(`Rolled back to version ${v}`);
                      setShowVersionHistory(false);
                    } catch (e) {
                      showError(String(e));
                    }
                  }}
                />
              </div>
            )}

            {/* Import/Export Panel */}
            {showImportExport && (
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, marginBottom: 16 }}>
                <ImportExport
                  templateId={selectedTemplateId}
                  onImported={(t) => {
                    setSelectedTemplateId(t.id);
                    setTemplateListKey((k) => k + 1);
                    showSuccess('Template imported successfully');
                  }}
                  onError={showError}
                />
              </div>
            )}
          </div>
        )}

        {view === 'meta' && (
          <MetaWorkflow
            onBack={() => setView('list')}
            onError={showError}
            onSuccess={showSuccess}
          />
        )}

        {view === 'projects' && (
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
            <ProjectList
              onSelect={(name) => {
                setSelectedProjectName(name);
                setView('project-detail');
              }}
              onError={showError}
            />
          </>
        )}

        {view === 'project-detail' && selectedProjectName && (
          <ProjectDetail
            projectName={selectedProjectName}
            onBack={() => setView('projects')}
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
