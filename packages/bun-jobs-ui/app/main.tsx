import { boot } from "./boot";
/**
 * The browser entry point `Bun.build` bundles: the stylesheets (emitted as
 * CSS files) and the app. Everything else lives in `boot.tsx`, so tests can
 * start the app without this module's import-time side effect.
 */
import "./styles/tokens.css";
import "./styles/base.css";
import "./components/components.css";

boot();
