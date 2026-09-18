export declare const VERSION: string;
export declare const PROTOCOL: 'p2l-game-v1';
export type Mode = 'demo' | 'platform';
export type State = 'loading' | 'waiting' | 'initialized' | 'playing' | 'paused' | 'submitting' | 'finished' | 'destroyed';
export interface Session { id: string; seed: number; expires_at: number; duration_ms: number; allow_pause: boolean; }
export interface TestConfig { game_id: string; key_id: string; private_key: string; parent_origin: string; }
export interface Options {
  gameId: string;
  rulesVersion: string;
  /** Omit to read mode=platform from the URL; otherwise default demo. embed is layout-only. */
  mode?: Mode;
  /** Trusted deployment configuration, never copy arbitrary origins from URL/referrer. */
  parentOrigin?: string;
  allowedParentOrigins?: string[];
  testConfig?: TestConfig;
  timeoutMs?: number;
  progressIntervalMs?: number;
}
export interface Progress { elapsed_ms: number; score: number; metrics?: Record<string, number>; }
export interface Finish extends Progress { inputs?: Array<{ tick: number; held: boolean }>; }
export interface Result { mode: Mode; status: 'local' | 'accepted' | 'rejected'; session_id: string; score: number | null; message?: string; }
export interface SDKError { code: string; message: string; retryable: boolean; }
export interface Events { init: Session; result: Result; error: SDKError; }
export interface GameSDK {
  readonly mode: Mode;
  readonly state: State;
  readonly session: Session | null;
  on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): () => void;
  ready(): void;
  start(): void;
  pause(): void;
  resume(): void;
  progress(value: Progress): boolean;
  finish(value: Finish): void;
  retrySubmission(): void;
  restart(): void;
  reportError(code: string, message: string): void;
  exit(): void;
  destroy(): void;
}
export declare function createGameSDK(options: Options): GameSDK;
export declare function installLegacyBridge(win?: Window): { destroy(): void } | undefined;
