import { ipcMain, shell } from 'electron';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';

import { IpcChannels } from '@shared/ipc';

import type { IpcDeps } from './types.js';

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

const SKILLS_ROOT = join(homedir(), '.jarvis', 'skills');

function skillFile(id: string): string {
  return join(SKILLS_ROOT, id, 'SKILL.md');
}

// SKILL.md ids are filesystem directory names. Reject anything that would
// escape the skills root or be ambiguous on disk — refuse traversal, slashes,
// and anything that isn't a slugged value.
function isSafeSkillId(id: string): boolean {
  if (typeof id !== 'string' || !id) return false;
  if (id.includes('/') || id.includes('\\') || id.includes('..')) return false;
  return slugify(id) === id;
}

export function registerSkillsIpc({ skills }: IpcDeps): void {
  ipcMain.handle(IpcChannels.listSkills, () => skills.list());
  ipcMain.handle(IpcChannels.refreshSkills, () => {
    skills.reloadAll();
    return skills.list();
  });

  ipcMain.handle(IpcChannels.readSkillBody, (_e, skillId: string) => {
    if (!isSafeSkillId(skillId)) return '';
    const found = skills.list().find((s) => s.id === skillId);
    if (!found) return '';
    const path = skillFile(skillId);
    if (!existsSync(path)) return '';
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return '';
    }
  });

  ipcMain.handle(
    IpcChannels.writeSkillBody,
    (_e, skillId: string, raw: string) => {
      if (!isSafeSkillId(skillId)) {
        return { ok: false, message: 'Invalid skill id.' };
      }
      if (typeof raw !== 'string') {
        return { ok: false, message: 'Body must be a string.' };
      }
      const path = skillFile(skillId);
      if (!existsSync(path)) {
        return { ok: false, message: 'Skill not found.' };
      }
      // Refuse to save if the YAML doesn't parse — a broken SKILL.md crashes
      // the loader on next reload and the skill silently disappears.
      try {
        matter(raw);
      } catch (err) {
        return {
          ok: false,
          message: `YAML frontmatter is invalid: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
      try {
        writeFileSync(path, raw, 'utf8');
        skills.reloadAll();
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.createSkill,
    (
      _e,
      input: { name: string; description?: string; body?: string },
    ) => {
      const name = String(input?.name ?? '').trim();
      if (!name) return { ok: false, message: 'Name is required.' };
      const id = slugify(name);
      if (!id) {
        return {
          ok: false,
          message: 'Name must contain alphanumeric characters.',
        };
      }
      const dir = join(SKILLS_ROOT, id);
      const path = join(dir, 'SKILL.md');
      if (existsSync(path)) {
        return { ok: false, message: `Skill "${id}" already exists.` };
      }
      const description = String(input?.description ?? '').trim();
      const body = String(
        input?.body ??
          [
            `---`,
            `name: ${name}`,
            `description: ${description || 'TODO: one-line summary of what this skill does.'}`,
            `allowed-tools: []`,
            `mcp-servers: []`,
            `---`,
            ``,
            `# ${name}`,
            ``,
            `Write the system prompt here. The body becomes the agent's instructions when this skill runs.`,
            ``,
          ].join('\n'),
      );
      // Validate frontmatter before writing.
      try {
        matter(body);
      } catch (err) {
        return {
          ok: false,
          message: `YAML frontmatter is invalid: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, body, 'utf8');
        skills.reloadAll();
        return { ok: true, id };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(IpcChannels.deleteSkill, (_e, skillId: string) => {
    if (!isSafeSkillId(skillId)) {
      return { ok: false, message: 'Invalid skill id.' };
    }
    const dir = join(SKILLS_ROOT, skillId);
    if (!existsSync(dir)) {
      return { ok: false, message: 'Skill not found.' };
    }
    try {
      rmSync(dir, { recursive: true, force: true });
      skills.reloadAll();
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle(IpcChannels.revealSkill, (_e, skillId: string) => {
    if (!isSafeSkillId(skillId)) return;
    const path = skillFile(skillId);
    if (existsSync(path)) {
      shell.showItemInFolder(path);
    } else {
      shell.showItemInFolder(SKILLS_ROOT);
    }
  });
}
