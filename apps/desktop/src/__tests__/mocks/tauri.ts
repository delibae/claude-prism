import { vi } from "vitest";

const storageData = new Map<string, string>();
const mockStorage = {
  getItem: vi.fn((key: string) => storageData.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    storageData.set(key, value);
  }),
  removeItem: vi.fn((key: string) => {
    storageData.delete(key);
  }),
  clear: vi.fn(() => {
    storageData.clear();
  }),
  key: vi.fn((index: number) => Array.from(storageData.keys())[index] ?? null),
  get length() {
    return storageData.size;
  },
};

const mockWebview = {
  setZoom: vi.fn(() => Promise.resolve()),
  onDragDropEvent: vi.fn(() => Promise.resolve(() => {})),
};

Object.defineProperty(window, "localStorage", {
  value: mockStorage,
  configurable: true,
});
Object.defineProperty(globalThis, "localStorage", {
  value: mockStorage,
  configurable: true,
});

// Mock @tauri-apps/api/core
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
}));

// Mock @tauri-apps/api/event
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// Mock @tauri-apps/api/webview
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: vi.fn(() => mockWebview),
}));

// Mock @tauri-apps/api/path
vi.mock("@tauri-apps/api/path", () => ({
  join: vi.fn((...args: string[]) => Promise.resolve(args.join("/"))),
}));

// Mock @tauri-apps/plugin-fs
vi.mock("@tauri-apps/plugin-fs", () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  readDir: vi.fn(),
  exists: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  copyFile: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
}));

// Mock @tauri-apps/plugin-shell
vi.mock("@tauri-apps/plugin-shell", () => ({
  Command: {
    create: vi.fn(),
  },
}));

// Mock @tauri-apps/plugin-dialog
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));
