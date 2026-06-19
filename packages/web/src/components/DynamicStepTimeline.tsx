import type { DynamicWorkflowStep } from '../types/dynamic-workflow';
import StatusBadge from './StatusBadge';

interface DynamicStepTimelineProps {
  steps: DynamicWorkflowStep[];
}

interface StepNode {
  step: DynamicWorkflowStep;
  children: StepNode[];
}

function stepLabel(step: DynamicWorkflowStep): string {
  return step.name || step.key || step.stepKey || step.id;
}

function parentReference(step: DynamicWorkflowStep): string | undefined {
  return step.parentKey || step.parentStepId || step.parentId || step.parentStepKey;
}

function buildStepTree(steps: DynamicWorkflowStep[]): StepNode[] {
  const nodes = new Map<string, StepNode>();
  const orderedNodes: StepNode[] = [];

  const visit = (step: DynamicWorkflowStep): StepNode => {
    const existing = nodes.get(step.id);
    if (existing) return existing;

    const node: StepNode = { step, children: [] };
    nodes.set(step.id, node);
    orderedNodes.push(node);
    for (const child of step.children ?? []) {
      node.children.push(visit(child));
    }
    return node;
  };

  for (const step of steps) visit(step);

  const nestedIds = new Set(
    orderedNodes.flatMap((node) => node.children.map((child) => child.step.id)),
  );
  const roots: StepNode[] = [];

  for (const node of orderedNodes) {
    if (nestedIds.has(node.step.id)) continue;

    const parent = parentReference(node.step);
    const parentNode = parent
      ? nodes.get(parent) ||
        orderedNodes.find(
          ({ step }) => step.key === parent || step.stepKey === parent,
        )
      : undefined;

    if (parentNode && parentNode !== node) {
      if (!parentNode.children.some((child) => child.step.id === node.step.id)) {
        parentNode.children.push(node);
      }
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function DetailBlock({
  label,
  value,
  error = false,
}: {
  label: string;
  value: unknown;
  error?: boolean;
}) {
  if (value === undefined || value === null || value === '') return null;

  return (
    <div style={{ marginTop: 8 }}>
      <span
        style={{
          display: 'block',
          marginBottom: 3,
          color: error ? '#991b1b' : '#6b7280',
          fontSize: '0.6875rem',
          fontWeight: 700,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </span>
      <pre
        style={{
          margin: 0,
          padding: '7px 9px',
          border: `1px solid ${error ? '#fecaca' : '#e5e7eb'}`,
          borderRadius: 4,
          backgroundColor: error ? '#fef2f2' : '#f9fafb',
          color: error ? '#991b1b' : '#374151',
          fontFamily: "'Courier New', Courier, monospace",
          fontSize: '0.75rem',
          lineHeight: 1.4,
          overflowX: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {displayValue(value)}
      </pre>
    </div>
  );
}

function StepItem({ node, depth }: { node: StepNode; depth: number }) {
  const { step } = node;
  const metadata = step.metadata ?? {};
  const replayed = step.replayed ?? metadata.replayed === true;
  const worktree =
    step.worktree ??
    step.workspacePath ??
    metadata.worktree ??
    metadata.workspacePath;
  const resultCommit = step.resultCommit ?? metadata.resultCommit;

  return (
    <>
      <div
        data-testid={`dynamic-step-${step.id}`}
        style={{
          position: 'relative',
          marginLeft: depth * 28,
          padding: '12px 14px 12px 32px',
          borderBottom: '1px solid #e5e7eb',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 17,
            left: 14,
            width: 9,
            height: 9,
            border: '2px solid #60a5fa',
            borderRadius: '50%',
            backgroundColor: '#fff',
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <span style={{ color: '#111827', fontSize: '0.875rem', fontWeight: 600 }}>
            {stepLabel(step)}
          </span>
          <span
            style={{
              padding: '1px 7px',
              border: '1px solid #dbeafe',
              borderRadius: 10,
              backgroundColor: '#eff6ff',
              color: '#1d4ed8',
              fontSize: '0.6875rem',
              fontWeight: 600,
            }}
          >
            {step.kind}
          </span>
          <StatusBadge status={step.status} />
          {step.attempt !== undefined && (
            <span style={{ color: '#6b7280', fontSize: '0.75rem' }}>
              Attempt {step.attempt}
            </span>
          )}
          {replayed && (
            <span
              style={{
                padding: '1px 7px',
                borderRadius: 10,
                backgroundColor: '#ede9fe',
                color: '#6d28d9',
                fontSize: '0.6875rem',
                fontWeight: 600,
              }}
            >
              Replayed
            </span>
          )}
        </div>

        <DetailBlock label="Worktree" value={worktree} />
        <DetailBlock label="Result commit" value={resultCommit} />
        <DetailBlock label="Error" value={step.error} error />
        <DetailBlock label="Output" value={step.output} />
      </div>
      {node.children.map((child) => (
        <StepItem key={child.step.id} node={child} depth={depth + 1} />
      ))}
    </>
  );
}

export default function DynamicStepTimeline({ steps }: DynamicStepTimelineProps) {
  const roots = buildStepTree(steps);

  return (
    <div style={{ overflow: 'hidden', border: '1px solid #e5e7eb', borderRadius: 8 }}>
      <div
        style={{
          padding: '10px 14px',
          borderBottom: '1px solid #e5e7eb',
          backgroundColor: '#f9fafb',
          color: '#374151',
          fontSize: '0.8125rem',
          fontWeight: 600,
        }}
      >
        Steps ({steps.length})
      </div>
      {roots.map((node) => (
        <StepItem key={node.step.id} node={node} depth={0} />
      ))}
    </div>
  );
}
