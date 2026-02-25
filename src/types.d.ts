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

  export interface SheetBase {
    ':private'?: {
      [sheetName: string]: {
        total?: number;
        limit?: number;
        offset?: number;
        data: SheetRecord[];
      }
    }
  }

  export interface SingleSheet extends SheetBase {
    total?: number;
    limit?: number;
    offset?: number;
    data?: SheetRecord[];
    ':sheetname'?: string;
    ':type'?: 'sheet';
    ':colWidths'?: number[];
  }

  export interface MultiSheet extends SheetBase {
    ':version': number;
    ':type': 'multi-sheet';
    ':names'?: string[];
    [sheetName: string]: Omit<SingleSheet, ':sheetname' | ':type'>;
  }

  export type Sheet = SingleSheet | MultiSheet;

  export interface FolderRecord extends Record<string, string> {
    path: string;
    name: string;
    ext: string;
    lastModified: number;
  }

  export type FolderList = FolderRecord[];
}

export { }
