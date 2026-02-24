import type { Core } from '@adobe/aio-sdk';

declare global {
  export interface Env extends Record<string, string> {
    ORG: string;
    SITE: string;
    SHEET: string;
  }

  export interface EventsConfig {
    apiKey: string;
    token: string;
    orgId: string;
    providerId: string;
    journalUrl: string;
  }

  export interface Context {
    env: Env;
    data: Record<string, unknown>;
    log: Console;
    info: {
      method: string;
      headers: Record<string, string>;
      path: string;
    };
    events: EventsConfig;
  }

  export interface SheetRecord extends Record<string, string> { }

  export interface Sheet {
    total?: number;
    limit?: number;
    offset?: number;
    data: SheetRecord[];
    ':sheetname': string;
    ':type': 'sheet';
    ':colWidths'?: number[];
  }

  export interface JournalEvent {
    position: string;
    event: Record<string, unknown>;
  }

  export interface JournalResponse {
    events: JournalEvent[];
    _page: { last?: string; count: number };
    _links?: Record<string, string>;
  }

  export interface JournalOptions {
    since?: string;
    latest?: boolean;
    limit?: number;
  }
}

export { }
