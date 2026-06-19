declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    registerCommand(name: string, options: any): void;
    registerTool(tool: any): void;
    on(event: string, handler: (event: any, ctx: ExtensionCommandContext) => unknown): void;
    sendUserMessage(content: string, options?: unknown): void;
    appendEntry<T = unknown>(customType: string, data: T): void;
  }

  export interface ExtensionContext {
    cwd: string;
    hasUI: boolean;
    ui: {
      editor: (prompt?: string, initialValue?: string) => Promise<string> | string;
      notify: (message: string, type?: string) => void;
      setEditorText: (text: string) => void;
      setStatus: (key: string, text: string) => void;
    };
    sessionManager: {
      getBranch?: () => unknown[];
      getEntries: () => unknown[];
    };
  }

  export type ExtensionCommandContext = ExtensionContext;
}

declare module "@earendil-works/pi-tui" {
  export const Box: unknown;
  export const Text: unknown;
}

declare module "typebox" {
  export interface Type {
    Object(schema: Record<string, unknown>): unknown;
    Array(schema: unknown): unknown;
    String(): unknown;
    Number(): unknown;
    Boolean(): unknown;
    Optional(schema: unknown): unknown;
    Union(schemas: unknown[]): unknown;
    Literal(value: string | number | boolean): unknown;
  }
}
