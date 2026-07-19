import { connect, type TLSSocket } from "node:tls";
import { channelLoginFromParam, ircToNormalizedMessage, parseIrcLine } from "./parse.js";
import type { NormalizedChatMessage } from "@chatterscope/contracts";

export type IrcEvents = {
  onMessage: (message: NormalizedChatMessage, channelLogin: string) => void;
  onLog: (level: "info" | "warn" | "error", event: string, detail?: unknown) => void;
};

const IRC_HOST = "irc.chat.twitch.tv";
const IRC_PORT = 6697;
const MAX_BACKOFF_MS = 60_000;

/**
 * Anonymous read-only Twitch IRC client (justinfan nick — the standard way
 * third-party tools observe public chat). Reconnects with backoff and rejoins
 * the watch list; JOINs are rate-limited to stay well under Twitch's limits.
 */
export class TwitchIrcClient {
  private socket: TLSSocket | null = null;
  private buffer = "";
  private channels = new Set<string>();
  private backoffMs = 1_000;
  private stopped = false;
  private joinQueue: string[] = [];
  private joinTimer: NodeJS.Timeout | null = null;

  constructor(private readonly events: IrcEvents) {}

  start(initialChannels: string[]): void {
    for (const channel of initialChannels) this.channels.add(channel.toLowerCase());
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.joinTimer) clearInterval(this.joinTimer);
    this.socket?.destroy();
  }

  join(channelLogin: string): void {
    const login = channelLogin.toLowerCase();
    if (this.channels.has(login)) return;
    this.channels.add(login);
    this.joinQueue.push(login);
  }

  part(channelLogin: string): void {
    const login = channelLogin.toLowerCase();
    if (!this.channels.delete(login)) return;
    this.send(`PART #${login}`);
  }

  watchedChannels(): string[] {
    return [...this.channels];
  }

  private connect(): void {
    if (this.stopped) return;
    this.events.onLog("info", "irc_connecting", { channels: this.channels.size });
    const socket = connect({ host: IRC_HOST, port: IRC_PORT, servername: IRC_HOST });
    this.socket = socket;
    socket.setEncoding("utf8");

    socket.on("secureConnect", () => {
      this.backoffMs = 1_000;
      const nick = `justinfan${Math.floor(10_000 + Math.random() * 80_000)}`;
      this.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      this.send(`NICK ${nick}`);
      this.joinQueue = [...this.channels];
      if (this.joinTimer) clearInterval(this.joinTimer);
      // ~1 JOIN/second keeps far below Twitch's 20 joins / 10s limit.
      this.joinTimer = setInterval(() => {
        const next = this.joinQueue.shift();
        if (next) this.send(`JOIN #${next}`);
      }, 1_000);
      this.events.onLog("info", "irc_connected", { nick });
    });

    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf("\r\n")) >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 2);
        this.handleLine(line);
      }
    });

    const scheduleReconnect = () => {
      if (this.stopped) return;
      if (this.joinTimer) clearInterval(this.joinTimer);
      this.events.onLog("warn", "irc_disconnected", { retryInMs: this.backoffMs });
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    };
    socket.on("error", (error) => {
      this.events.onLog("error", "irc_socket_error", { message: error.message });
    });
    socket.on("close", scheduleReconnect);
  }

  private handleLine(line: string): void {
    const message = parseIrcLine(line);
    if (!message) return;
    if (message.command === "PING") {
      this.send(`PONG :${message.params[0] ?? "tmi.twitch.tv"}`);
      return;
    }
    if (message.command === "RECONNECT") {
      this.socket?.destroy();
      return;
    }
    if (message.command === "PRIVMSG") {
      const normalized = ircToNormalizedMessage(message, line);
      if (normalized) {
        this.events.onMessage(normalized, channelLoginFromParam(message.params[0] ?? ""));
      }
    }
  }

  private send(line: string): void {
    this.socket?.write(`${line}\r\n`);
  }
}
