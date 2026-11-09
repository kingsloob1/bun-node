import type { ModulesContainer } from "@nestjs/core";
import process from "node:process";
import { Inject, Logger } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import {
  NEST_PARAMTYPES_METADATA,
  NEST_SELF_DECLARED_DEPS_METADATA,
} from "./metadata";

/** The dependency {@link DecoratorProbe} names. */
class ProbeDependency {}

/**
 * Decorated with syntax on purpose, unlike every other class here: it answers
 * how Bun transpiled this process's decorators. Bun reads
 * `experimentalDecorators` and `emitDecoratorMetadata` from the working
 * directory's `tsconfig.json`, not the file's (oven-sh/bun#28605), for a file
 * under `node_modules` too (measured), so this class is treated as the
 * application's own are.
 */
class DecoratorProbe {
  constructor(
    /** Never built: only the metadata of this parameter is read. */
    @Inject("bun-jobs:decorator-probe") readonly dependency: ProbeDependency,
  ) {}
}

/** The parts of a Nest class wrapper the check reads. */
interface WrapperView {
  /** The class, or a factory; `null` for a value. */
  readonly metatype?: unknown;
  /** A factory's dependencies; unset for a class. */
  readonly inject?: unknown;
}

/** The names of the classes Nest will build with `undefined` for their parameters. */
function classesMissingMetadata(modules: ModulesContainer): string[] {
  const names = new Set<string>();
  for (const module of modules.values()) {
    const wrappers = [
      ...module.providers.values(),
      ...module.controllers.values(),
    ] as WrapperView[];
    for (const { metatype, inject } of wrappers) {
      if (
        typeof metatype === "function" &&
        // Every module's own `ModuleRef`: Nest's, already built, and abstract.
        metatype !== ModuleRef &&
        (inject === undefined || inject === null) &&
        metatype.length > 0 &&
        !Reflect.hasMetadata(NEST_PARAMTYPES_METADATA, metatype) &&
        !Reflect.hasMetadata(NEST_SELF_DECLARED_DEPS_METADATA, metatype)
      ) {
        names.add(metatype.name);
      }
    }
  }
  return [...names].sort();
}

/**
 * Risk R3 of the plan: with the decorator options off in the working
 * directory's `tsconfig.json`, Bun drops parameter decorators without a word
 * and Nest injects `undefined`. This turns that into a message.
 *
 * The probe says what Bun did to this package's files; a class with
 * constructor parameters and no metadata at all says it matters. Both must
 * hold: an application built ahead of time and run without a `tsconfig.json`
 * has decorated classes of its own whatever the probe found, and is fine.
 *
 * @returns The problem, or `undefined` when there is none.
 */
export function decoratorConfigProblem(
  /** The application's modules. */
  modules: ModulesContainer,
): string | undefined {
  if (Reflect.hasMetadata(NEST_PARAMTYPES_METADATA, DecoratorProbe)) {
    return undefined;
  }
  const classes = classesMissingMetadata(modules);
  if (classes.length === 0) {
    new Logger("BunJobsModule").debug(
      "decorator metadata is off for this package's files, and no class here is missing any",
    );
    return undefined;
  }
  return `decorator metadata is off, so Nest would inject undefined into ${classes.join(", ")}. Bun reads experimentalDecorators and emitDecoratorMetadata from the tsconfig.json of the working directory (${process.cwd()}), not the file's (oven-sh/bun#28605): run from the application's root, or set both in that tsconfig.json`;
}
