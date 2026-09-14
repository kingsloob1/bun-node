import type { DateParser, DateParseResult } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunJobs,
  BunQueue,
  CHRONO_VERSION_RANGE,
  ConfigError,
  MemoryDriver,
} from "../lib/index";
import {
  checkChrono,
  missingChronoError,
  parseWhen,
  readRecurrence,
} from "../lib/shared/humanTime";
import { testNamespace } from "./helpers";

/**
 * A date parser of the consumer's own, in place of `chrono-node`.
 *
 * The one used here knows a single word, "payday", so any date these tests
 * see came from it: chrono would not read "payday" as anything.
 */

/** When payday is, in these tests. */
const PAYDAY = new Date(2026, 11, 25, 9, 0, 0);
/** A second instant, for the end of a range. */
const YEAR_END = new Date(2026, 11, 31, 17, 0, 0);

/** A parser that reads "payday" and "year end", and nothing else. */
function paydayParser(calls: string[] = []): DateParser {
  return {
    parse(text) {
      calls.push(text);
      const results: DateParseResult[] = [];

      for (const [word, date] of [
        ["payday", PAYDAY],
        ["year end", YEAR_END],
      ] as const) {
        const index = text.indexOf(word);

        if (index >= 0) {
          results.push({ index, text: word, start: { date: () => date } });
        }
      }

      return results;
    },
  };
}

describe("a custom date parser", () => {
  let jobs: BunJobs | undefined;

  afterEach(async () => {
    await jobs?.close();
    jobs = undefined;
  });

  /** A context using the payday parser. */
  function withParser(parser: DateParser) {
    jobs = new BunJobs({
      namespace: testNamespace(),
      driver: new MemoryDriver(),
      logger: noopLogger,
      dateParser: parser,
    });
    jobs.define("salaries", async () => null);
    return jobs;
  }

  it("reads on() through the parser, with no parseDate of its own", async () => {
    const calls: string[] = [];
    const context = withParser(paydayParser(calls));

    const job = await context.run("salaries").on("payday").start();

    expect(job.runAt).toBe(PAYDAY.getTime());
    expect(calls).toEqual(["payday"]);
  });

  it("uses parseDate when the parser has one", async () => {
    const context = withParser({
      parse: () => [],
      parseDate: (text) => (text === "payday" ? PAYDAY : null),
    });

    const job = await context.run("salaries").on("payday").start();
    expect(job.runAt).toBe(PAYDAY.getTime());
  });

  it("reads the dates inside every() and the interval around them", async () => {
    const context = withParser(paydayParser());

    const job = await context
      .run("salaries")
      .every("every 2 weeks from payday until year end")
      .start();

    const [series] = await context.queue("jobs").listRepeatables();
    expect(series!.every).toBe(14 * 86_400_000);
    expect(series!.startAt).toBe(PAYDAY.getTime());
    expect(series!.endAt).toBe(YEAR_END.getTime());
    expect(job.runAt).toBe(PAYDAY.getTime());
  });

  it("is used by repeat options on queue.add", async () => {
    const queue = new BunQueue("direct", {
      namespace: testNamespace(),
      driver: new MemoryDriver(),
      logger: noopLogger,
      dateParser: paydayParser(),
    });

    const job = await queue.add(
      "salaries",
      {},
      { repeat: { every: "1 day", startAt: "payday" } },
    );

    expect(job.runAt).toBe(PAYDAY.getTime());
    await queue.close();
  });

  it("a queue's own parser wins over the context's", async () => {
    const context = withParser(paydayParser());
    const other: DateParser = {
      parse: (text) =>
        text === "payday"
          ? [{ index: 0, text, start: { date: () => YEAR_END } }]
          : [],
    };

    const queue = context.queue("own-parser", { dateParser: other });
    const job = await queue.add(
      "salaries",
      {},
      {
        repeat: { every: "1 day", startAt: "payday" },
      },
    );

    expect(job.runAt).toBe(YEAR_END.getTime());
  });

  it("fails on words the parser does not read, as chrono would", () => {
    const context = withParser(paydayParser());

    // "christmas" is not one of its words, so no date covers it and it is
    // left over — which is not part of an interval either.
    expect(() =>
      context.run("salaries").every("every 2 weeks from christmas"),
    ).toThrow(ConfigError);
  });
});

describe("checking a date parser's shape", () => {
  it("refuses a parser without parse, and describes the interface", () => {
    for (const bad of [
      {},
      { parse: "no" },
      null,
      { parse: () => [], parseDate: 1 },
    ]) {
      const build = () =>
        new BunJobs({
          namespace: testNamespace(),
          driver: new MemoryDriver(),
          logger: noopLogger,
          dateParser: bad as never,
        });

      expect(build).toThrow(ConfigError);
      expect(build).toThrow("parse(text: string");
      expect(build).toThrow("start: { date(): Date }");
    }
  });

  it("refuses results that do not fit the shape, saying what was wrong", () => {
    const now = PAYDAY.getTime() - 86_400_000;
    const cases: [DateParser, RegExp][] = [
      [{ parse: () => "payday" as never }, /other than an array/],
      [
        {
          parse: () => [
            { index: 3, text: "payday", start: { date: () => PAYDAY } },
          ],
        },
        /not at its index/,
      ],
      [
        {
          parse: (text) => [
            { index: 0, text, start: { date: () => new Date(Number.NaN) } },
          ],
        },
        /start\.date\(\) is not a valid Date/,
      ],
      [
        {
          parse: (text) => [
            {
              index: 0,
              text,
              start: { date: () => PAYDAY },
              end: { date: () => "soon" as never },
            },
          ],
        },
        /end\.date\(\) is not a valid Date/,
      ],
    ];

    for (const [parser, message] of cases) {
      expect(() => parseWhen("payday", "runAt", now, parser)).toThrow(message);
    }

    expect(() =>
      parseWhen("payday", "runAt", now, {
        parse: () => [],
        parseDate: () => "tomorrow" as never,
      }),
    ).toThrow(/parseDate returned/);
  });

  it("misreports nothing when a result's position is honest", () => {
    const read = readRecurrence(
      "every 3 days from payday",
      "every()",
      PAYDAY.getTime() - 86_400_000,
      paydayParser(),
    );
    expect(read).toEqual({ every: 3 * 86_400_000, startAt: PAYDAY.getTime() });
  });
});

describe("chrono-node, when it is the parser", () => {
  it("names the version range and the interface when it is missing", () => {
    const error = missingChronoError("on()", "2nd december 2026", "not found");

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain(`chrono-node ${CHRONO_VERSION_RANGE}`);
    expect(error.message).toContain(
      `bun add chrono-node@"${CHRONO_VERSION_RANGE}"`,
    );
    expect(error.message).toContain("dateParser option");
    expect(error.message).toContain("parse(text: string, reference: Date");
    expect(error.message).toContain("parseDate?(");
  });

  it("refuses an installed version outside the range", () => {
    const shaped = { parse: () => [], parseDate: () => null };

    expect(() => checkChrono(shaped, "3.0.0")).toThrow(
      /chrono-node 3\.0\.0 is installed, but >=2\.7\.0 <3 is required/,
    );
    expect(() => checkChrono(shaped, "2.6.9")).toThrow(ConfigError);
    expect(checkChrono(shaped, "2.10.1")).toBe(shaped);
  });

  it("refuses a module in range that does not have the interface", () => {
    expect(() => checkChrono({ parseDate: () => null }, "2.8.0")).toThrow(
      /chrono-node 2\.8\.0 is not a date parser/,
    );
  });

  it("is what reads phrases when no parser is given", async () => {
    const queue = new BunQueue("chrono-default", {
      namespace: testNamespace(),
      driver: new MemoryDriver(),
      logger: noopLogger,
    });

    const job = await queue.add(
      "report",
      {},
      { repeat: { every: "every 2 days starting 1st december 2026" } },
    );
    expect(new Date(job.runAt).getDate()).toBe(1);
    await queue.close();
  });
});
