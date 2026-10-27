// Test-only: the one react-dom/server function `client/reacharound-mode.test.ts`
// renders the page with. Declared here rather than adding @types/react-dom,
// which is not in the dependency tree (supply-chain rule: no new packages for
// a test). Nothing in the package's runtime source imports react-dom.
declare module "react-dom/server" {
  import type { ReactNode } from "react";
  export function renderToString(node: ReactNode): string;
}
