// isomorphic-git expects Node's Buffer; browsers need the polyfill installed
// before it runs. Import this module first.
import { Buffer } from 'buffer';

const g = globalThis as unknown as { Buffer?: typeof Buffer };
g.Buffer ??= Buffer;
