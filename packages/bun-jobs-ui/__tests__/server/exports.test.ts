/**
 * The package entry's runtime surface, pinned. The asset/build machinery and
 * the manifest types are internal (`scripts/build.ts` and the tests import
 * `lib/assets.ts` directly), so a new export here is a deliberate API change,
 * never an accident.
 */
import type {
  JobsUi,
  JobsUiApiOptions,
  JobsUiAuthorize,
  JobsUiAuthorizeContext,
  JobsUiAuthorizeResult,
  JobsUiBaseOptions,
  JobsUiOptions,
  JobsUiUrlOptions,
  UiConfig,
  UiSections,
  UiTheme,
} from "../../lib/index";
import { describe, expect, it } from "bun:test";
import * as entry from "../../lib/index";

describe("lib/index.ts", () => {
  it("exports exactly the public runtime values", () => {
    expect(Object.keys(entry).sort()).toEqual([
      "ASSET_CACHE_CONTROL",
      "DEFAULT_BASE_PATH",
      "DEFAULT_TITLE",
      "UI_CONFIG_ELEMENT_ID",
      "jobsUi",
    ]);
  });
});

// The public types, named once so the tests' typecheck fails if one is
// dropped. (Types have no runtime keys, so the list above cannot see them.)
export type PublicTypes = [
  JobsUi,
  JobsUiOptions,
  JobsUiApiOptions,
  JobsUiUrlOptions,
  JobsUiBaseOptions,
  JobsUiAuthorize,
  JobsUiAuthorizeContext,
  JobsUiAuthorizeResult,
  UiConfig,
  UiSections,
  UiTheme,
];
