import { boot } from "./boot";
/**
 * The browser entry point `Bun.build` bundles: the stylesheets (emitted as
 * CSS files) and the viewer. Everything else lives in `boot.tsx`, so tests
 * can start the app without this module's import-time side effect.
 */
import "../kit/styles/tokens.css";
import "../kit/styles/base.css";
import "./styles/viewer.css";
import "../kit/components/components.css";

boot();
