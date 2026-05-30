import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';
import { loadSkillRaw, isSkillAvailable } from '../../../src/gstack/skill-loader.js';

describe('loadSkillRaw', () => {
  it('loads a skill from an explicit repo fixture', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'workflow-gstack-'));
    const skillDir = join(repoDir, 'plan-ceo-review');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: plan-ceo-review\n---\n# plan-ceo-review');

    const content = await loadSkillRaw('plan-ceo-review', repoDir);
    expect(content).toBeDefined();
    expect(content).toContain('plan-ceo-review');
  });

  it('returns undefined for nonexistent skill', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'workflow-gstack-'));
    const content = await loadSkillRaw('nonexistent-skill', repoDir);
    expect(content).toBeUndefined();
  });

  it('loads from an explicit installed skills fixture', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'workflow-empty-gstack-'));
    const skillsDir = await mkdtemp(join(tmpdir(), 'workflow-installed-skills-'));
    const installedSkillDir = join(skillsDir, 'gstack-ship');
    await mkdir(installedSkillDir, { recursive: true });
    await writeFile(join(installedSkillDir, 'SKILL.md'), '---\nname: ship\n---\n# ship');

    const content = await loadSkillRaw('ship', repoDir, skillsDir);
    expect(content).toBeDefined();
    expect(content).toContain('ship');
  });
});

describe('isSkillAvailable', () => {
  it('returns false for nonexistent skill', async () => {
    expect(await isSkillAvailable('nonexistent')).toBe(false);
  });
});
