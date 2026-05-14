import { ipcMain, shell } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { IpcChannels } from '@shared/ipc';

import { listClaudeMcps } from '../claude-mcp.js';
import { invokeMcpTool } from '../mcp-invoke.js';
import { probeMcpTools } from '../mcp-probe.js';
import type { IpcDeps } from './types.js';

export function registerMcpIpc({ mcp, auth }: IpcDeps): void {
  ipcMain.handle(IpcChannels.listMcpServers, () => mcp.list());

  ipcMain.handle(IpcChannels.listClaudeMcps, async () => {
    return listClaudeMcps(auth.currentBinaryPath() ?? '');
  });

  ipcMain.handle(
    IpcChannels.addMcpServer,
    (
      _e,
      input: {
        id: string;
        type: 'stdio' | 'sse' | 'http';
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        url?: string;
        headers?: Record<string, string>;
      },
    ): { ok: boolean; message?: string } => {
      try {
        if (input.type === 'stdio') {
          if (!input.command) {
            return { ok: false, message: 'stdio servers require a command.' };
          }
          mcp.upsert(input.id, {
            type: 'stdio',
            command: input.command,
            args: input.args && input.args.length ? input.args : undefined,
            env:
              input.env && Object.keys(input.env).length ? input.env : undefined,
          });
        } else {
          if (!input.url) {
            return { ok: false, message: `${input.type} servers require a URL.` };
          }
          mcp.upsert(input.id, {
            type: input.type,
            url: input.url,
            headers:
              input.headers && Object.keys(input.headers).length
                ? input.headers
                : undefined,
          });
        }
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
    IpcChannels.removeMcpServer,
    (_e, id: string): { ok: boolean; message?: string } => {
      if (typeof id !== 'string' || !id) {
        return { ok: false, message: 'Invalid server id.' };
      }
      const removed = mcp.remove(id);
      return removed ? { ok: true } : { ok: false, message: 'Not found.' };
    },
  );

  ipcMain.handle(IpcChannels.readMcpFile, () => ({
    path: mcp.path,
    contents: mcp.rawFileContents(),
  }));

  ipcMain.handle(IpcChannels.revealMcpFile, async () => {
    const target =
      mcp.rawFileContents() !== null ? mcp.path : join(homedir(), '.jarvis');
    shell.showItemInFolder(target);
  });

  ipcMain.handle(IpcChannels.probeMcpTools, async (_e, id: string) => {
    if (typeof id !== 'string' || !id) {
      return { ok: false, message: 'Invalid server id.' };
    }
    return probeMcpTools(mcp, id);
  });

  ipcMain.handle(
    IpcChannels.invokeMcpTool,
    async (
      _e,
      payload: { id: string; toolName: string; args: Record<string, unknown> },
    ) => {
      if (
        !payload ||
        typeof payload.id !== 'string' ||
        typeof payload.toolName !== 'string'
      ) {
        return { ok: false, message: 'Invalid invoke payload.' };
      }
      return invokeMcpTool(
        mcp,
        payload.id,
        payload.toolName,
        payload.args ?? {},
      );
    },
  );
}
