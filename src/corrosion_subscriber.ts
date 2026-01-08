/**
 * Corrosion subscription client
 *
 * Connects to Corrosion's /v1/subscriptions endpoint and streams
 * real-time updates about container changes.
 */

import type {
  CorrosionChangeMessage,
  CorrosionColumnsMessage,
  CorrosionMessage,
  CorrosionRowsMessage,
  DnsRecord,
  SubscriberEvents,
} from "./types.ts";

/**
 * SQL query for subscribing to container changes
 *
 * Selects containers joined with services to get project info.
 * Only returns healthy containers.
 */
const SUBSCRIPTION_QUERY = `
SELECT
  c.id,
  c.service,
  c.server_id,
  c.ip,
  c.healthy,
  c.health_status,
  c.started_at,
  c.instance_id,
  s.project
FROM containers c
JOIN services s ON c.service = s.name
WHERE c.healthy = 1 OR c.health_status = 'healthy'
`.trim();

/**
 * Column indices in the subscription query result
 */
const COLUMNS = {
  ID: 0,
  SERVICE: 1,
  SERVER_ID: 2,
  IP: 3,
  HEALTHY: 4,
  HEALTH_STATUS: 5,
  STARTED_AT: 6,
  INSTANCE_ID: 7,
  PROJECT: 8,
};

/**
 * Corrosion subscription client
 *
 * Maintains a streaming HTTP connection to Corrosion and emits
 * events when containers are added, updated, or removed.
 */
export class CorrosionSubscriber {
  private corrosionApi: string;
  private events: SubscriberEvents;
  private reconnectInterval: number;
  private maxReconnectAttempts: number;
  private abortController: AbortController | null = null;
  private reconnectAttempt = 0;
  private isRunning = false;
  private columnNames: string[] = [];

  constructor(
    corrosionApi: string,
    events: SubscriberEvents,
    reconnectInterval = 5000,
    maxReconnectAttempts = 0, // 0 = unlimited
  ) {
    this.corrosionApi = corrosionApi;
    this.events = events;
    this.reconnectInterval = reconnectInterval;
    this.maxReconnectAttempts = maxReconnectAttempts;
  }

  /**
   * Start the subscription
   *
   * Connects to Corrosion and begins streaming updates.
   * Automatically reconnects on connection loss.
   */
  async start(): Promise<void> {
    this.isRunning = true;
    await this.connect();
  }

  /**
   * Stop the subscription
   *
   * Closes the connection and stops reconnection attempts.
   */
  stop(): void {
    this.isRunning = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /**
   * Connect to Corrosion subscription endpoint
   */
  private async connect(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      this.abortController = new AbortController();

      const response = await fetch(`${this.corrosionApi}/v1/subscriptions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: "jiji-dns",
          query: SUBSCRIPTION_QUERY,
        }),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`Subscription failed: ${response.status} ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error("No response body");
      }

      // Reset reconnect attempts on successful connection
      this.reconnectAttempt = 0;

      // Process the NDJSON stream
      await this.processStream(response.body);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        // Connection was intentionally aborted
        return;
      }

      this.events.onError(error instanceof Error ? error : new Error(String(error)));
      await this.scheduleReconnect();
    }
  }

  /**
   * Process the NDJSON stream from Corrosion
   */
  private async processStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (this.isRunning) {
        const { done, value } = await reader.read();

        if (done) {
          // Stream ended, schedule reconnect
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);

          if (line.length > 0) {
            this.processLine(line);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // If we get here and still running, schedule reconnect
    if (this.isRunning) {
      await this.scheduleReconnect();
    }
  }

  /**
   * Process a single NDJSON line
   */
  private processLine(line: string): void {
    try {
      const message = JSON.parse(line) as CorrosionMessage;

      if ("columns" in message) {
        this.handleColumns(message);
      } else if ("rows" in message) {
        this.handleRows(message);
      } else if ("change" in message) {
        this.handleChange(message);
      } else if ("eoq" in message) {
        // End of initial query, all existing data has been sent
        this.events.onReady();
      }
    } catch (error) {
      console.error(`Failed to parse line: ${line}`, error);
    }
  }

  /**
   * Handle columns message (first message in stream)
   */
  private handleColumns(message: CorrosionColumnsMessage): void {
    this.columnNames = message.columns;
  }

  /**
   * Handle rows message (initial data batch)
   */
  private handleRows(message: CorrosionRowsMessage): void {
    for (const row of message.rows) {
      const record = this.rowToRecord(row);
      if (record) {
        this.events.onUpsert(record);
      }
    }
  }

  /**
   * Handle change message (real-time updates)
   */
  private handleChange(message: CorrosionChangeMessage): void {
    const change = message.change;

    if ("Insert" in change) {
      const record = this.rowToRecord(change.Insert.values);
      if (record) {
        this.events.onUpsert(record);
      }
    } else if ("Update" in change) {
      const record = this.rowToRecord(change.Update.values);
      if (record) {
        this.events.onUpsert(record);
      }
    } else if ("Delete" in change) {
      const containerId = change.Delete.pk[0];
      if (typeof containerId === "string") {
        this.events.onDelete(containerId);
      }
    }
  }

  /**
   * Convert a row array to a DnsRecord
   */
  private rowToRecord(row: (string | number | null)[]): DnsRecord | null {
    const id = row[COLUMNS.ID];
    const service = row[COLUMNS.SERVICE];
    const serverId = row[COLUMNS.SERVER_ID];
    const ip = row[COLUMNS.IP];
    const healthy = row[COLUMNS.HEALTHY];
    const healthStatus = row[COLUMNS.HEALTH_STATUS];
    const startedAt = row[COLUMNS.STARTED_AT];
    const instanceId = row[COLUMNS.INSTANCE_ID];
    const project = row[COLUMNS.PROJECT];

    // Validate required fields
    if (
      typeof id !== "string" ||
      typeof service !== "string" ||
      typeof serverId !== "string" ||
      typeof ip !== "string" ||
      typeof project !== "string"
    ) {
      return null;
    }

    // Determine health: check health_status first, fall back to healthy column
    let isHealthy = true;
    if (typeof healthStatus === "string") {
      isHealthy = healthStatus === "healthy";
    } else if (typeof healthy === "number") {
      isHealthy = healthy === 1;
    }

    return {
      containerId: id,
      service,
      project,
      serverId,
      ip,
      healthy: isHealthy,
      startedAt: typeof startedAt === "number" ? startedAt : Date.now(),
      instanceId: typeof instanceId === "string" ? instanceId : undefined,
    };
  }

  /**
   * Schedule a reconnection attempt
   */
  private async scheduleReconnect(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.reconnectAttempt++;

    if (this.maxReconnectAttempts > 0 && this.reconnectAttempt > this.maxReconnectAttempts) {
      this.events.onError(
        new Error(`Max reconnect attempts (${this.maxReconnectAttempts}) exceeded`),
      );
      return;
    }

    this.events.onReconnect(this.reconnectAttempt);

    // Exponential backoff with jitter
    const baseDelay = Math.min(
      this.reconnectInterval * Math.pow(2, this.reconnectAttempt - 1),
      60000,
    );
    const jitter = Math.random() * 1000;
    const delay = baseDelay + jitter;

    await new Promise((resolve) => setTimeout(resolve, delay));

    if (this.isRunning) {
      await this.connect();
    }
  }
}
