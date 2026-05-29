import { ipcMain } from 'electron';

import { IpcChannels } from '@shared/ipc';
import type { ArtifactKind } from '@shared/types';

import {
  countByKind,
  listAllLinks,
  listArtifacts,
  listFacets,
  readArtifact,
  readChunk,
  semanticChunkNeighbors,
  semanticNeighbors,
} from '../artifacts/index.js';

/**
 * IPC for the /memory graph view + future power-user surfaces. The
 * agent's MCP tools sit alongside (jarvis-mcp.ts) — these are the
 * renderer-only flavour.
 */
export function registerArtifactsIpc(): void {
  ipcMain.handle(
    IpcChannels.artifactsList,
    (
      _e,
      opts: {
        kind?: ArtifactKind | ArtifactKind[];
        project?: string;
        since?: number;
        limit?: number;
      } = {},
    ) => listArtifacts(opts),
  );
  ipcMain.handle(IpcChannels.artifactsRead, (_e, id: string) =>
    readArtifact(id),
  );
  ipcMain.handle(IpcChannels.artifactsLinks, () => listAllLinks());
  ipcMain.handle(
    IpcChannels.artifactsSemanticNeighbors,
    (_e, opts: { threshold?: number; k?: number } = {}) =>
      semanticNeighbors(opts.threshold ?? 0.7, opts.k ?? 5),
  );
  ipcMain.handle(IpcChannels.artifactsCountByKind, () => countByKind());

  ipcMain.handle(
    IpcChannels.artifactsListFacets,
    (
      _e,
      opts: {
        kind?: ArtifactKind | ArtifactKind[];
        project?: string;
        since?: number;
        limit?: number;
        minChunkChars?: number;
      } = {},
    ) => listFacets(opts),
  );

  ipcMain.handle(IpcChannels.artifactsReadChunk, (_e, chunkId: string) =>
    readChunk(chunkId),
  );

  ipcMain.handle(
    IpcChannels.artifactsSemanticChunkNeighbors,
    (_e, opts: { threshold?: number; k?: number } = {}) =>
      semanticChunkNeighbors(opts.threshold ?? 0.4, opts.k ?? 6),
  );
}
