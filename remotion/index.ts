/**
 * Remotion entry point for the ad tool.
 *
 * This folder is EXCLUDED from the app's tsconfig — it has its own dependency
 * set (`remotion`, `@remotion/bundler`, `@remotion/renderer`, `@remotion/cli`,
 * `react`, `react-dom`). The app invokes it via dynamic import in
 * src/lib/ad-render.ts → renderAdFormat(). To install:
 *
 *   npm i remotion @remotion/bundler @remotion/renderer @remotion/cli
 *
 * Preview locally: `npx remotion studio remotion/index.ts`
 */
import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";

registerRoot(RemotionRoot);
