import { createArcadeSDK, type ArcadeSDK } from '@play2launch/game-sdk';

// Create once per persistent game component; destroy in the component's onDestroy.
export class P2LArcade {
  readonly sdk: ArcadeSDK;
  constructor(trustedParentOrigin: string) {
    this.sdk = createArcadeSDK({ parentOrigin: trustedParentOrigin });
  }
  destroy() { this.sdk.destroy(); }
}
