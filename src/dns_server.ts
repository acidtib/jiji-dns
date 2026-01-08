/**
 * UDP DNS server for service discovery
 *
 * Handles DNS queries:
 * - *.{serviceDomain} queries → lookup in cache
 * - Other queries → forward to system resolver
 */

import type { DnsServerConfig } from "./types.ts";
import { DnsQueryType } from "./types.ts";
import { DnsCache } from "./dns_cache.ts";
import {
  buildDnsResponse,
  buildServfailResponse,
  extractHostname,
  isServiceDomain,
  parseDnsQuery,
} from "./dns_protocol.ts";
import { DnsResponseCode } from "./types.ts";

/**
 * DNS server that handles queries and routes them to cache or upstream
 */
export class DnsServer {
  private config: DnsServerConfig;
  private cache: DnsCache;
  private listener: Deno.DatagramConn | null = null;
  private isRunning = false;
  private systemResolvers: string[] = [];

  constructor(config: DnsServerConfig, cache: DnsCache) {
    this.config = config;
    this.cache = cache;
  }

  /**
   * Start the DNS server
   */
  async start(): Promise<void> {
    // Parse listen address
    const [host, portStr] = this.config.listenAddr.split(":");
    const port = parseInt(portStr, 10);

    // Load system resolvers
    this.systemResolvers = await this.loadSystemResolvers();
    console.log(`System resolvers: ${this.systemResolvers.join(", ")}`);

    // Bind to UDP socket
    this.listener = Deno.listenDatagram({
      port,
      hostname: host,
      transport: "udp",
    });

    this.isRunning = true;
    console.log(`DNS server listening on ${this.config.listenAddr}`);

    // Handle incoming queries
    await this.handleQueries();
  }

  /**
   * Stop the DNS server
   */
  stop(): void {
    this.isRunning = false;
    if (this.listener) {
      this.listener.close();
      this.listener = null;
    }
  }

  /**
   * Main query handling loop
   */
  private async handleQueries(): Promise<void> {
    if (!this.listener) {
      return;
    }

    while (this.isRunning) {
      try {
        const [data, remoteAddr] = await this.listener.receive();
        // Handle query in background
        this.handleQuery(data, remoteAddr).catch((error) => {
          console.error("Error handling query:", error);
        });
      } catch (error) {
        if (this.isRunning) {
          console.error("Error receiving packet:", error);
        }
      }
    }
  }

  /**
   * Handle a single DNS query
   */
  private async handleQuery(data: Uint8Array, remoteAddr: Deno.Addr): Promise<void> {
    if (!this.listener) {
      return;
    }

    let response: Uint8Array;

    try {
      const query = parseDnsQuery(data);

      // Check if this is a query for our service domain
      if (isServiceDomain(query.domain, this.config.serviceDomain)) {
        response = this.handleServiceQuery(query.domain, query.transactionId, query.queryType);
      } else {
        // Forward to upstream resolver
        response = await this.forwardQuery(data);
      }
    } catch (error) {
      console.error("Error processing query:", error);
      // Try to send SERVFAIL response
      try {
        const query = parseDnsQuery(data);
        response = buildServfailResponse(query);
      } catch {
        // Can't even parse the query, nothing to send
        return;
      }
    }

    // Send response
    try {
      await this.listener.send(response, remoteAddr);
    } catch (error) {
      console.error("Error sending response:", error);
    }
  }

  /**
   * Handle a query for our service domain
   */
  private handleServiceQuery(
    domain: string,
    transactionId: number,
    queryType: DnsQueryType,
  ): Uint8Array {
    // We only handle A record queries
    if (queryType !== DnsQueryType.A) {
      return buildDnsResponse({
        transactionId,
        responseCode: DnsResponseCode.NOERROR,
        domain,
        ips: [],
        ttl: this.config.ttl || 60,
      });
    }

    // Extract hostname and lookup in cache
    const hostname = extractHostname(domain, this.config.serviceDomain);
    const ips = this.cache.get(hostname);

    if (ips.length === 0) {
      // No records found
      return buildDnsResponse({
        transactionId,
        responseCode: DnsResponseCode.NXDOMAIN,
        domain,
        ips: [],
        ttl: this.config.ttl || 60,
      });
    }

    // Return all IPs
    return buildDnsResponse({
      transactionId,
      responseCode: DnsResponseCode.NOERROR,
      domain,
      ips,
      ttl: this.config.ttl || 60,
    });
  }

  /**
   * Forward a query to upstream DNS resolver
   */
  private async forwardQuery(queryData: Uint8Array): Promise<Uint8Array> {
    if (this.systemResolvers.length === 0) {
      throw new Error("No system resolvers available");
    }

    // Try each resolver in order
    for (const resolver of this.systemResolvers) {
      try {
        return await this.queryResolver(queryData, resolver);
      } catch (error) {
        console.warn(`Resolver ${resolver} failed:`, error);
        continue;
      }
    }

    throw new Error("All resolvers failed");
  }

  /**
   * Send query to a single resolver and wait for response
   */
  private async queryResolver(queryData: Uint8Array, resolver: string): Promise<Uint8Array> {
    const conn = Deno.listenDatagram({
      port: 0, // Ephemeral port
      hostname: "0.0.0.0",
      transport: "udp",
    });

    try {
      // Send query
      const resolverAddr: Deno.NetAddr = {
        transport: "udp",
        hostname: resolver,
        port: 53,
      };
      await conn.send(queryData, resolverAddr);

      // Wait for response with timeout
      const responsePromise = conn.receive();
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Resolver timeout")), 5000);
      });

      const [response] = await Promise.race([responsePromise, timeoutPromise]);
      return response;
    } finally {
      conn.close();
    }
  }

  /**
   * Load system DNS resolvers from /etc/resolv.conf
   */
  private async loadSystemResolvers(): Promise<string[]> {
    try {
      const content = await Deno.readTextFile("/etc/resolv.conf");
      const resolvers: string[] = [];

      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("nameserver")) {
          const parts = trimmed.split(/\s+/);
          if (parts.length >= 2) {
            const ip = parts[1];
            // Skip localhost and our own address
            if (
              ip !== "127.0.0.1" &&
              ip !== "::1" &&
              !this.config.listenAddr.startsWith(ip)
            ) {
              resolvers.push(ip);
            }
          }
        }
      }

      // If no valid resolvers found, use common defaults
      if (resolvers.length === 0) {
        return ["8.8.8.8", "1.1.1.1"];
      }

      return resolvers;
    } catch {
      // Fallback to public DNS
      return ["8.8.8.8", "1.1.1.1"];
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): { cacheStats: ReturnType<DnsCache["getStats"]>; resolvers: string[] } {
    return {
      cacheStats: this.cache.getStats(),
      resolvers: this.systemResolvers,
    };
  }
}
