import { describe, it, expect } from 'vitest';
import { WorkflowFSM, type WorkflowAction } from './state-machine.js';
import type { WorkflowStatus } from '@dynflow/shared';

describe('WorkflowFSM', () => {
  describe('valid transitions', () => {
    type ValidCase = {
      from: WorkflowStatus;
      action: WorkflowAction;
      to: WorkflowStatus;
      label: string;
    };

    const validCases: ValidCase[] = [
      { from: 'pending', action: 'start', to: 'running', label: 'pending → start → running' },
      { from: 'running', action: 'pause', to: 'paused', label: 'running → pause → paused' },
      { from: 'running', action: 'complete', to: 'completed', label: 'running → complete → completed' },
      { from: 'running', action: 'fail', to: 'failed', label: 'running → fail → failed' },
      { from: 'running', action: 'stop', to: 'stopped', label: 'running → stop → stopped' },
      { from: 'running', action: 'interrupt', to: 'interrupted', label: 'running → interrupt → interrupted' },
      { from: 'paused', action: 'resume', to: 'running', label: 'paused → resume → running' },
      { from: 'paused', action: 'stop', to: 'stopped', label: 'paused → stop → stopped' },
    ];

    validCases.forEach(({ from, action, to, label }) => {
      it(label, () => {
        const result = WorkflowFSM.transition(from, action);
        expect(result.allowed).toBe(true);
        expect(result.next).toBe(to);
        expect(result.error).toBeUndefined();
      });
    });

    validCases.forEach(({ from, action, to, label }) => {
      it(`canTransition: ${label}`, () => {
        expect(WorkflowFSM.canTransition(from, action)).toBe(true);
      });
    });
  });

  describe('invalid transitions', () => {
    type InvalidCase = {
      from: WorkflowStatus;
      action: WorkflowAction;
      label: string;
    };

    const invalidCases: InvalidCase[] = [
      // Running cannot accept start again
      { from: 'running', action: 'start', label: 'running → start' },
      // Pending cannot accept anything except start
      { from: 'pending', action: 'pause', label: 'pending → pause' },
      { from: 'pending', action: 'resume', label: 'pending → resume' },
      { from: 'pending', action: 'complete', label: 'pending → complete' },
      { from: 'pending', action: 'fail', label: 'pending → fail' },
      { from: 'pending', action: 'stop', label: 'pending → stop' },
      { from: 'pending', action: 'interrupt', label: 'pending → interrupt' },
      // Completed cannot accept any action
      { from: 'completed', action: 'start', label: 'completed → start' },
      { from: 'completed', action: 'pause', label: 'completed → pause' },
      { from: 'completed', action: 'resume', label: 'completed → resume' },
      { from: 'completed', action: 'complete', label: 'completed → complete' },
      { from: 'completed', action: 'fail', label: 'completed → fail' },
      { from: 'completed', action: 'stop', label: 'completed → stop' },
      { from: 'completed', action: 'interrupt', label: 'completed → interrupt' },
      // Failed cannot accept any action
      { from: 'failed', action: 'start', label: 'failed → start' },
      { from: 'failed', action: 'resume', label: 'failed → resume' },
      // Stopped cannot accept any action
      { from: 'stopped', action: 'start', label: 'stopped → start' },
      { from: 'stopped', action: 'resume', label: 'stopped → resume' },
      // Interrupted cannot accept any action
      { from: 'interrupted', action: 'start', label: 'interrupted → start' },
      { from: 'interrupted', action: 'resume', label: 'interrupted → resume' },
      // Double-pause
      { from: 'paused', action: 'pause', label: 'paused → pause (double-pause)' },
      // Paused cannot accept start, complete, fail, interrupt
      { from: 'paused', action: 'start', label: 'paused → start' },
      { from: 'paused', action: 'complete', label: 'paused → complete' },
      { from: 'paused', action: 'fail', label: 'paused → fail' },
      { from: 'paused', action: 'interrupt', label: 'paused → interrupt' },
    ];

    invalidCases.forEach(({ from, action, label }) => {
      it(label, () => {
        const result = WorkflowFSM.transition(from, action);
        expect(result.allowed).toBe(false);
        expect(result.next).toBeUndefined();
        expect(result.error).toContain(`Cannot '${action}'`);
        expect(result.error).toContain(`'${from}'`);
      });
    });

    invalidCases.forEach(({ from, action, label }) => {
      it(`canTransition: ${label}`, () => {
        expect(WorkflowFSM.canTransition(from, action)).toBe(false);
      });
    });
  });
});
