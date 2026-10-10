// React's default document: React renders <html> itself, so <title> and
// <meta> anywhere in the view are hoisted into <head>.
import type { ReactNode } from "react";
export function DefaultDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head><meta charSet="utf-8" /></head>
      <body><div id="bv-root">{children}</div></body>
    </html>
  );
}
