import { ipcMain } from 'electron';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, normalize, relative, resolve } from 'node:path';

import { IpcChannels } from '@shared/ipc';
import type { ProjectInput, ProjectTemplateSummary } from '@shared/types';

import { BUILTIN_TEMPLATES, findTemplate } from '../seeds/templates/index.js';
import type { IpcDeps } from './types.js';

export function registerProjectsIpc({
  projects,
  projectMemory,
  userContext,
  jarvisRoot,
}: IpcDeps): void {
  ipcMain.handle(IpcChannels.listProjects, () => projects.list());

  // List built-in workflow templates as renderer-facing summaries (no
  // template body — the memory seeds stay in main). Used by the New
  // Project dialog to populate its template picker.
  ipcMain.handle(IpcChannels.listProjectTemplates, (): ProjectTemplateSummary[] =>
    BUILTIN_TEMPLATES.map((t) => ({
      id: t.id,
      label: t.label,
      description: t.description,
      recommendedSkills: t.recommendedSkills,
      recommendedMcps: t.recommendedMcps,
      memorySeedCount: t.memorySeeds.length,
    })),
  );

  ipcMain.handle(IpcChannels.createProject, (_e, input: ProjectInput) => {
    // 1. Create the project entry first — fails loudly on duplicate name
    //    before we touch the filesystem.
    const def = projects.create(input);
    // 2. If a template was selected, seed its memory files. We never
    //    overwrite an existing file (a user re-creating after manual
    //    experimentation should keep their notes).
    const template = findTemplate(input.templateId ?? null);
    for (const seed of template.memorySeeds) {
      const existing = projectMemory.read(def.name, seed.file);
      if (existing) continue;
      projectMemory.write(def.name, seed.file, seed.content);
    }
    return def;
  });

  // Cache the renderer's scope-picker selection in main, so the
  // UserContextStore can inject it into every task's system prompt.
  ipcMain.handle(IpcChannels.setActiveProject, (_e, name: string | null) => {
    userContext.setActiveProject(typeof name === 'string' ? name : null);
  });

  ipcMain.handle(IpcChannels.listProjectMemory, (_e, project: string) =>
    projectMemory.list(project),
  );

  ipcMain.handle(
    IpcChannels.readProjectMemory,
    (_e, payload: { project: string; file: string }) =>
      projectMemory.read(payload.project, payload.file),
  );

  ipcMain.handle(
    IpcChannels.writeProjectMemory,
    (
      _e,
      payload: { project: string; file: string; content: string },
    ) => {
      projectMemory.write(payload.project, payload.file, payload.content);
    },
  );

  ipcMain.handle(
    IpcChannels.deleteProjectMemory,
    (_e, payload: { project: string; file: string }) =>
      projectMemory.remove(payload.project, payload.file),
  );

  // Delete a single timestamped entry from a daily notes/<date>.md file.
  // Each entry is a `## HH:MM\n\n<body>\n` block; we splice by index and
  // rewrite (deleting the last entry removes the file).
  const resolveSafe = (rel: string): string => {
    const target = normalize(resolve(jarvisRoot, rel || '.'));
    const within = relative(jarvisRoot, target);
    if (within.startsWith('..') || within === '..') {
      throw new Error(`Path escapes ~/.jarvis: ${rel}`);
    }
    return target;
  };

  ipcMain.handle(
    IpcChannels.deleteNoteEntry,
    (
      _e,
      { date, fileIndex }: { date: string; fileIndex: number },
    ): { ok: boolean; message?: string } => {
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return { ok: false, message: 'Invalid date' };
      }
      if (!Number.isInteger(fileIndex) || fileIndex < 0) {
        return { ok: false, message: 'Invalid entry index' };
      }
      const path = resolveSafe(join('notes', `${date}.md`));
      let raw: string;
      try {
        raw = readFileSync(path, 'utf8');
      } catch {
        return { ok: false, message: 'Note file not found' };
      }
      const re = /(?:^|\n)(## \d{2}:\d{2}\n[\s\S]*?)(?=\n## \d{2}:\d{2}|$)/g;
      const blocks: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw)) !== null) blocks.push(m[1]!);
      if (fileIndex >= blocks.length) {
        return { ok: false, message: 'Entry not found' };
      }
      blocks.splice(fileIndex, 1);
      if (blocks.length === 0) {
        try {
          rmSync(path);
        } catch {
          // ignore
        }
        return { ok: true };
      }
      writeFileSync(path, blocks.join('\n') + '\n', 'utf8');
      return { ok: true };
    },
  );
}
