export declare const VERSION: string;
export declare const PROTOCOL: 'p2l-game-v1';
export type Mode = 'demo' | 'platform';
export type State = 'loading' | 'waiting' | 'initialized' | 'playing' | 'paused' | 'submitting' | 'finished' | 'destroyed';
export interface Session { id: string; seed: number; expires_at: number; duration_ms: number; allow_pause: boolean; }
export interface RealtimeSession extends Omit<Session,'seed'> { realtime:{version:'realtime-v1';tick_ms:number;starts_at:number}; }
export interface TestConfig { game_id: string; key_id: string; private_key: string; parent_origin: string; }
export interface Options {
  capabilities?: Array<'metrics-v1'|'realtime-v1'>;
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
export interface Result { mode: Mode; status: 'local' | 'accepted' | 'rejected'; session_id: string; score: number | null; metrics?: Record<string,number>; message?: string; }
export interface SDKError { code: string; message: string; retryable: boolean; }
export interface RealtimeSnapshot { pending?:{round:number;action_id:string;direction:'long'|'short'}; revision:number;server_time:number;round:number;deadline_at:number;status:'playing'|'finished'|'cancelled';rounds:Array<{choice?:'long'|'short';round:number;direction:'up'|'down';outcome:'win'|'loss'|'miss';score:number;combo:number}>;metrics:Record<string,number>; }
export interface Events { realtime_init:RealtimeSession; snapshot:RealtimeSnapshot; action:{round:number;action_id:string;accepted:boolean}; init: Session; result: Result; error: SDKError; }
export interface GameSDK {
  readonly mode: Mode;
  readonly state: State;
  readonly session: Session | null;
  readonly realtimeSession: RealtimeSession | null;
  on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): () => void;
  action(round:number,direction:'long'|'short'):string;
  sync():void;
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
/** Casual game APIs; reporting is not proof of score authenticity. */
export interface ArcadeSDK {
 ready(): Promise<{session_id:string;game_id:string;capabilities:string[];test:boolean}>;
 getUserProfile(): Promise<{id:string;displayName:string;userName:string;avatarUrl:string}>;
 loading(value:number): Promise<unknown>;
 getData(key:string): Promise<{key:string;data:string;version:number}>;
 setData(key:string,data:string,version?:number): Promise<{key:string;version:number}>;
 report(metric:string,value:number,requestId?:string): Promise<unknown>;
 getTasks(): Promise<unknown[]>;
 getBalance(): Promise<{balance:number;test:boolean}>;
 getProducts(): Promise<unknown[]>;
 requestPayment(product:{title:string;desc?:string;price:number;info?:string},requestId?:string): Promise<{paymentId:string;invoiceLink:string}>;
 openInvoice(paymentId:string): Promise<{paymentId:string;status:string}>;
 purchase(productId:string,quantity?:number,payload?:string,requestId?:string): Promise<unknown>;
 getOrder(orderId:string): Promise<unknown>;
 getOrders(): Promise<unknown[]>;
 confirmDelivery(orderId:string): Promise<unknown>;
 exit(): Promise<unknown>;
 destroy(): void;
}
export function createArcadeSDK(options:{parentOrigin:string},win?:Window):ArcadeSDK;
