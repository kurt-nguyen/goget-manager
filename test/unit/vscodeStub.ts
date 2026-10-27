// Minimal stand-in for the `vscode` module so adapter-adjacent code can be
// unit tested in plain Node. Extend only as tests need more of the API.

export type Listener<T> = (e: T) => unknown;

export interface Disposable {
  dispose(): void;
}

export class EventEmitter<T = void> {
  private listeners: Listener<T>[] = [];

  readonly event = (listener: Listener<T>): Disposable => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };

  fire(data: T): void {
    for (const l of [...this.listeners]) {
      l(data);
    }
  }

  dispose(): void {
    this.listeners = [];
  }
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly path: string,
  ) {}

  static file(path: string): Uri {
    return new Uri('file', path.replace(/\\/g, '/'));
  }

  static parse(value: string): Uri {
    const i = value.indexOf(':');
    return i < 0 ? new Uri('file', value) : new Uri(value.slice(0, i), value.slice(i + 1).replace(/^\/\//, ''));
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, [base.path.replace(/\/+$/, ''), ...segments].join('/'));
  }

  get fsPath(): string {
    return this.path;
  }

  toString(): string {
    return `${this.scheme}://${this.path}`;
  }
}

export class ThemeIcon {
  constructor(readonly id: string) {}
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  description?: string | boolean;
  tooltip?: string;
  iconPath?: ThemeIcon;
  id?: string;
  contextValue?: string;

  constructor(
    public label: string,
    public collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
  ) {}
}

export class FileSystemError extends Error {
  constructor(
    message: string,
    readonly code: string = 'Unknown',
  ) {
    super(message);
    this.name = 'FileSystemError';
  }

  static FileNotFound(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(typeof messageOrUri === 'string' ? messageOrUri : 'File not found', 'FileNotFound');
  }

  static FileExists(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(typeof messageOrUri === 'string' ? messageOrUri : 'File exists', 'FileExists');
  }

  static NoPermissions(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(typeof messageOrUri === 'string' ? messageOrUri : 'No permissions', 'NoPermissions');
  }

  static Unavailable(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(typeof messageOrUri === 'string' ? messageOrUri : 'Unavailable', 'Unavailable');
  }
}
