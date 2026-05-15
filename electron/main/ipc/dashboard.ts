import { ipcMain } from 'electron';

import { IpcChannels } from '@shared/ipc';
import type { DashboardConfig } from '@shared/types';

import type { IpcDeps } from './types.js';

export function registerDashboardIpc({ dashboard }: IpcDeps): void {
  ipcMain.handle(IpcChannels.readDashboard, () => dashboard.read());

  ipcMain.handle(
    IpcChannels.writeDashboard,
    (_e, next: DashboardConfig) => dashboard.write(next),
  );
}
