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
  activity,
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

  ipcMain.handle(
    IpcChannels.updateProject,
    (
      _e,
      payload: { currentName: string; patch: ProjectInput },
    ) => {
      const result = projects.update(payload.currentName, payload.patch);
      activity.record({
        kind: 'project.updated',
        label: `Project updated · ${payload.currentName}${
          payload.patch.name && payload.patch.name !== payload.currentName
            ? ` → ${payload.patch.name}`
            : ''
        }`,
        detail: { previousName: payload.currentName, patch: payload.patch },
      });
      return result;
    },
  );

  ipcMain.handle(IpcChannels.deleteProject, (_e, name: string) => {
    if (typeof name !== 'string' || !name) {
      throw new Error('project name required');
    }
    projects.remove(name);
    activity.record({
      kind: 'project.deleted',
      label: `Project deleted · ${name}`,
      detail: { name },
    });
  });

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
    activity.record({
      kind: 'project.created',
      label: `Project created · ${def.name}${
        input.templateId ? ` (template: ${input.templateId})` : ''
      }`,
      detail: { name: def.name, templateId: input.templateId ?? null },
    });
    return def;
  });

  // Cache the renderer's scope-picker selection in main, so the
  // UserContextStore can inject it into every task's system prompt.
  // No activity row — this fires on every scope dropdown change and
  // would flood the feed (the user often switches scope mid-flow).
  ipcMain.handle(IpcChannels.setActiveProject, (_e, name: string | null) => {
    userContext.setActiveProject(typeof name === 'string' ? name : null);
  });

  // Toggle the per-project "scan this repo's PRs in the inbox" flag.
  // Persisted to projects.json; the gh inbox sources read it on next
  // refresh.
  ipcMain.handle(
    IpcChannels.setProjectInboxScan,
    (_e, payload: { name: string; enabled: boolean }) => {
      if (typeof payload?.name !== 'string') return;
      projects.setInboxScan(payload.name, payload.enabled === true);
      activity.record({
        kind: 'project.inbox-scan-toggled',
        label: `Project inbox scan · ${payload.name} · ${
          payload.enabled ? 'on' : 'off'
        }`,
        detail: { name: payload.name, enabled: payload.enabled === true },
      });
    },
  );

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
        activity.record({
          kind: 'note.deleted',
          label: `Note deleted · notes/${date}.md (last entry — file removed)`,
          detail: { path, date, fileIndex },
        });
        return { ok: true };
      }
      writeFileSync(path, blocks.join('\n') + '\n', 'utf8');
      activity.record({
        kind: 'note.deleted',
        label: `Note deleted · notes/${date}.md (#${fileIndex + 1})`,
        detail: { path, date, fileIndex },
      });
      return { ok: true };
    },
  );

  /**
   * Soft-archive (or restore) a note entry. Inserts/removes an
   * `<!-- jarvis:archived: <ISO> -->` marker as the first body line of
   * the entry. The entry stays in its original date file; the UI parser
   * looks for the marker and splits Active vs. Archived. Restore = pass
   * archived:false. Permanent delete still goes through deleteNoteEntry.
   */
  ipcMain.handle(
    IpcChannels.setNoteEntryArchived,
    (
      _e,
      {
        date,
        fileIndex,
        archived,
      }: { date: string; fileIndex: number; archived: boolean },
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
      const ARCHIVE_RX = /<!-- jarvis:archived:[^\n]*-->\n/;
      const block = blocks[fileIndex]!;
      const headerMatch = block.match(/^(## \d{2}:\d{2}\n)([\s\S]*)$/);
      if (!headerMatch) {
        return { ok: false, message: 'Malformed entry header' };
      }
      const header = headerMatch[1]!;
      let body = headerMatch[2]!;
      body = body.replace(ARCHIVE_RX, '');
      if (archived) {
        body = `<!-- jarvis:archived:${new Date().toISOString()} -->\n${body}`;
      }
      blocks[fileIndex] = header + body;
      writeFileSync(path, blocks.join('\n') + '\n', 'utf8');
      activity.record({
        kind: archived ? 'note.archived' : 'note.restored',
        label: archived
          ? `Note archived · notes/${date}.md (#${fileIndex + 1})`
          : `Note restored · notes/${date}.md (#${fileIndex + 1})`,
        detail: { path, date, fileIndex },
      });
      return { ok: true };
    },
  );
}
