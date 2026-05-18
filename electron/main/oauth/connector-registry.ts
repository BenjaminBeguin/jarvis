import type { ConnectorId } from '@shared/types';

import type { Connector } from './types.js';

/**
 * Plain Map wrapper for connectors. The registry is intentionally
 * un-clever — adding a connector is a one-line `register(...)` call
 * during boot. Phase 1 registers only test-echo; phase 2+ adds Slack,
 * Google, Notion, Linear.
 */
export class ConnectorRegistry {
  private readonly map = new Map<ConnectorId, Connector>();

  register(connector: Connector): void {
    if (this.map.has(connector.id)) {
      throw new Error(`Connector already registered: ${connector.id}`);
    }
    this.map.set(connector.id, connector);
  }

  get(id: ConnectorId): Connector | null {
    return this.map.get(id) ?? null;
  }

  list(): Connector[] {
    return [...this.map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}
