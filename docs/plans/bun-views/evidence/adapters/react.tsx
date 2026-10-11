// The React adapter: no compile step (Bun loads .tsx), a whole-document
// render, React's own stream, and whole-document hydration.
import type { ComponentType } from "react";
import { renderToReadableStream, renderToString } from "react-dom/server";
import type { RenderInput, ViewAdapter } from "../core/interface";
import { DefaultDocument } from "./react-document";

type Mode = "string" | "buffered";

function tree({ component: View, module, props }: RenderInput<ComponentType<Record<string, unknown>>>) {
  const Doc = (module.document as typeof DefaultDocument | undefined) ?? DefaultDocument;
  return <Doc><View {...props} /></Doc>;
}

function options(input: RenderInput) {
  return {
    nonce: input.nonce,
    signal: input.signal,
    onError: input.onError,
    bootstrapScriptContent: input.bootstrap?.propsScript,
    bootstrapModules: input.bootstrap ? [{ src: input.bootstrap.src, integrity: input.bootstrap.integrity }] : undefined,
  };
}

export function reactAdapter({ mode = "buffered" as Mode } = {}): ViewAdapter<ComponentType<Record<string, unknown>>> {
  return {
    name: "react",
    extensions: [".tsx", ".jsx"],
    async render(input) {
      if (mode === "string" && !input.bootstrap) {
        return { kind: "document", html: `<!DOCTYPE html>${renderToString(tree(input))}` };
      }
      const stream = await renderToReadableStream(tree(input), options(input));
      await stream.allReady;
      return { kind: "document", html: await new Response(stream).text() };
    },
    async renderToStream(input) {
      return { kind: "document", stream: await renderToReadableStream(tree(input), options(input)) };
    },
    clientEntry: ({ viewPath, propsGlobal }) => `
import { hydrateRoot } from "react-dom/client";
import { DefaultDocument } from ${JSON.stringify(`${import.meta.dir}/react-document.tsx`)};
import View from ${JSON.stringify(viewPath)};
hydrateRoot(document, <DefaultDocument><View {...self.${propsGlobal}} /></DefaultDocument>, {
  onRecoverableError: (e) => console.error("recoverable: " + String(e)),
});
`,
  };
}
