import type { Response } from 'express';
import type { SSEEvent } from '@dynflow/shared';
import { v4 as uuidv4 } from 'uuid';

interface ClientEntry {
  clientId: string;
  res: Response;
}

export class StreamManager {
  private static instance: StreamManager;
  private clients = new Map<string, ClientEntry[]>();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private lastEventId = 0;
  private readonly HEARTBEAT_MS = 15000;

  static getInstance(): StreamManager {
    if (!this.instance) {
      this.instance = new StreamManager();
    }
    return this.instance;
  }

  addClient(workflowId: string, res: Response): string {
    const clientId = uuidv4();
    if (!this.clients.has(workflowId)) {
      this.clients.set(workflowId, []);
    }
    this.clients.get(workflowId)!.push({ clientId, res });
    if (this.clients.size === 1) {
      this.startHeartbeat();
    }
    return clientId;
  }

  removeClient(workflowId: string, clientId: string): void {
    const entries = this.clients.get(workflowId);
    if (!entries) return;
    this.clients.set(
      workflowId,
      entries.filter((e) => e.clientId !== clientId),
    );
    if (this.clients.get(workflowId)!.length === 0) {
      this.clients.delete(workflowId);
    }
    if (this.clients.size === 0) {
      this.stopHeartbeat();
    }
  }

  emit(workflowId: string, event: SSEEvent): void {
    const entries = this.clients.get(workflowId);
    if (!entries) return;
    this.lastEventId++;
    const lines = `id: ${this.lastEventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const entry of entries) {
      entry.res.write(lines);
    }
  }

  getClientCount(workflowId?: string): number {
    if (workflowId) {
      return this.clients.get(workflowId)?.length ?? 0;
    }
    let count = 0;
    for (const entries of this.clients.values()) {
      count += entries.length;
    }
    return count;
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) return;
    this.heartbeatInterval = setInterval(() => {
      for (const [, entries] of this.clients) {
        for (const entry of entries) {
          entry.res.write(`: heartbeat\n\n`);
        }
      }
    }, this.HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /** For testing: force-reset singleton state */
  static resetInstance(): void {
    const instance = StreamManager.instance;
    if (instance) {
      instance.stopHeartbeat();
      instance.clients.clear();
      instance.lastEventId = 0;
    }
    StreamManager.instance = undefined as unknown as StreamManager;
  }
}
