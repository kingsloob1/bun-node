import { describe, expect, it, mock } from "bun:test";
import { ApiError } from "../../app/api/errors";
import { Badge, Chip } from "../../app/components/Badge";
import { Button } from "../../app/components/Button";
import { Card } from "../../app/components/Card";
import { EmptyState } from "../../app/components/EmptyState";
import { ErrorView } from "../../app/components/ErrorView";
import { Sparkline } from "../../app/components/Sparkline";
import { sparkPoints } from "../../app/components/sparkPoints";
import { Spinner } from "../../app/components/Spinner";
import { StateBadge } from "../../app/components/StateBadge";
import { Table } from "../../app/components/Table";
import { createLimiter } from "../../app/limiter";
import { fireEvent, page, render, setupDom } from "./dom";

setupDom();

describe("Button", () => {
  it("defaults to type=button and the secondary variant", () => {
    const onClick = mock(() => {});
    render(<Button onClick={onClick}>Go</Button>);
    const button = page().getByRole("button", { name: "Go" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.className).toBe("btn btn-secondary");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("takes a variant, a size and a submit type", () => {
    render(
      <Button
        variant="danger"
        size="sm"
        type="submit"
        className="x"
      >
        Delete
      </Button>,
    );
    const button = page().getByRole("button", { name: "Delete" });
    expect(button.getAttribute("type")).toBe("submit");
    expect(button.className).toBe("btn btn-danger btn-sm x");
  });
});

describe("Badge, Chip, StateBadge", () => {
  it("render their text and tone classes", () => {
    render(
      <>
        <Badge tone="warning">Paused</Badge>
        <Chip
          label="driver"
          value="redis"
        />
        <StateBadge state="waiting-children" />
      </>,
    );
    expect(page().getByText("Paused").className).toBe("badge badge-warning");
    expect(page().getByText("driver").parentElement!.textContent).toBe(
      "driverredis",
    );
    const state = page().getByText("Waiting children");
    expect(state.className).toBe("state-badge state-waiting-children");
  });
});

describe("Card", () => {
  it("is a region labelled by its title", () => {
    render(
      <Card
        title="Queues"
        actions={<button type="button">Act</button>}
      >
        body
      </Card>,
    );
    const region = page().getByRole("region", { name: "Queues" });
    expect(region.textContent).toContain("body");
    expect(region.textContent).toContain("Act");
  });
});

describe("Table", () => {
  it("is a focusable, labelled scroll region with a caption", () => {
    render(
      <Table label="Workers">
        <thead>
          <tr>
            <th>id</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>w1</td>
          </tr>
        </tbody>
      </Table>,
    );
    const region = page().getByRole("region", { name: "Workers" });
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(page().getByRole("table", { name: "Workers" })).toBeTruthy();
  });
});

describe("EmptyState and Spinner", () => {
  it("render text and a status role", () => {
    render(
      <>
        <EmptyState
          title="Nothing"
          description="Really nothing"
          action={<a href="#x">Do</a>}
        />
        <Spinner label="Loading queues" />
      </>,
    );
    expect(page().getByText("Really nothing")).toBeTruthy();
    expect(page().getByRole("status").textContent).toBe("Loading queues");
  });
});

describe("ErrorView", () => {
  it("renders an ApiError's title, detail, code, status and issues", () => {
    const onRetry = mock(() => {});
    const error = new ApiError({
      kind: "problem",
      status: 400,
      code: "VALIDATION",
      title: "Validation failed",
      detail: "The request is invalid",
      issues: [
        { target: "query", path: "minutes", message: "must be <= 1440" },
        { target: "body", path: "", message: "must be an object" },
      ],
    });
    render(
      <ErrorView
        error={error}
        onRetry={onRetry}
      />,
    );
    const alert = page().getByRole("alert");
    expect(alert.textContent).toContain("Validation failed");
    expect(alert.textContent).toContain("The request is invalid");
    expect(alert.textContent).toContain("VALIDATION · HTTP 400");
    expect(alert.textContent).toContain("query.minutes must be <= 1440");
    expect(alert.textContent).toContain("body must be an object");
    fireEvent.click(page().getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders a plain error, without a status for a network failure", () => {
    render(<ErrorView error={new Error("boom")} />);
    expect(page().getByRole("alert").textContent).toBe(
      "Something went wrongboom",
    );
    expect(page().queryByRole("button")).toBeNull();
  });
});

describe("Sparkline", () => {
  it("scales points into the box, oldest on the left, highest at the top", () => {
    expect(sparkPoints([0, 10], 10, 104, 24)).toBe("2.0,22.0 102.0,2.0");
    expect(sparkPoints([5], 10, 104, 24)).toBe("52.0,12.0");
    expect(sparkPoints([], 10, 104, 24)).toBe("");
    expect(sparkPoints([0, 0], 0, 104, 24)).toBe("2.0,22.0 102.0,22.0");
  });

  it("is an img with an accessible label and both series", () => {
    render(
      <Sparkline
        values={[1, 2, 3]}
        secondary={[0, 1, 0]}
        label="emails throughput"
      />,
    );
    const svg = page().getByRole("img", { name: "emails throughput" });
    expect(svg.querySelectorAll("polyline")).toHaveLength(2);
    expect(svg.querySelector(".sparkline-primary")).toBeTruthy();
  });
});

describe("createLimiter", () => {
  it("never runs more than max at once, and runs everything", async () => {
    const limiter = createLimiter(2);
    let running = 0;
    let peak = 0;
    const task = (value: number) => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return value;
    };
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((value) => limiter.run(task(value))),
    );
    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
    expect(limiter.active).toBe(0);
    expect(limiter.pending).toBe(0);
  });

  it("frees the slot when a task fails", async () => {
    const limiter = createLimiter(1);
    const failed = limiter.run(async () => {
      throw new Error("no");
    });
    const next = limiter.run(async () => "ok");
    expect(failed).rejects.toThrow("no");
    expect(await next).toBe("ok");
  });
});
