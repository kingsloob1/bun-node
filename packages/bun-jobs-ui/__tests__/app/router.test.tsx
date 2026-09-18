import { describe, expect, it } from "bun:test";
import { Link, RouterProvider, Routes } from "../../app/router";
import {
  matchPath,
  normalizeBasePath,
  stripBasePath,
  useLocation,
  useParams,
  useQueryParam,
} from "../../app/routing";
import { act, fireEvent, page, render, setupDom, visit } from "./dom";

setupDom();

describe("stripBasePath", () => {
  it("scopes paths under the base", () => {
    expect(stripBasePath("/jobs", "/jobs")).toBe("/");
    expect(stripBasePath("/jobs/", "/jobs")).toBe("/");
    expect(stripBasePath("/jobs/queues/emails", "/jobs")).toBe(
      "/queues/emails",
    );
    expect(stripBasePath("/jobs/queues/", "/jobs")).toBe("/queues");
  });

  it("refuses paths outside the base, including a shared prefix", () => {
    expect(stripBasePath("/jobsx", "/jobs")).toBeNull();
    expect(stripBasePath("/other", "/jobs")).toBeNull();
    expect(stripBasePath("/", "/jobs")).toBeNull();
  });

  it("handles a nested base and a root mount", () => {
    expect(stripBasePath("/admin/jobs/queues", "/admin/jobs/")).toBe("/queues");
    expect(stripBasePath("/queues", "")).toBe("/queues");
    expect(stripBasePath("/", "/")).toBe("/");
    expect(normalizeBasePath("jobs/")).toBe("/jobs");
  });
});

describe("matchPath", () => {
  it("binds params, percent-decoded", () => {
    expect(matchPath("/queues/:queue", "/queues/a%2Fb")).toEqual({
      queue: "a/b",
    });
    expect(matchPath("/queues/:queue/jobs/:id", "/queues/q/jobs/42")).toEqual({
      queue: "q",
      id: "42",
    });
  });

  it("requires the same number of segments", () => {
    expect(matchPath("/queues/:queue", "/queues")).toBeNull();
    expect(matchPath("/queues/:queue", "/queues/a/b")).toBeNull();
    expect(matchPath("/queues", "/runners")).toBeNull();
    expect(matchPath("/", "/")).toEqual({});
  });

  it("binds a trailing * to the rest", () => {
    expect(matchPath("/docs/*", "/docs/http/getMeta")).toEqual({
      "*": "http/getMeta",
    });
    expect(matchPath("/docs/*", "/docs")).toEqual({ "*": "" });
  });

  it("keeps a malformed escape as it is", () => {
    expect(matchPath("/q/:x", "/q/%E0%A4%A")).toEqual({ x: "%E0%A4%A" });
  });
});

/** Shows the bound params. */
function ShowParams() {
  return <p data-testid="params">{JSON.stringify(useParams())}</p>;
}

/** Shows the location. */
function ShowLocation() {
  const location = useLocation();
  return <p data-testid="location">{`${location.path}${location.search}`}</p>;
}

/** A filter box bound to `?q=`. */
function Filter() {
  const [q, setQ] = useQueryParam("q");
  return (
    <input
      aria-label="filter"
      value={q}
      onChange={(event) => setQ(event.target.value)}
    />
  );
}

/** A small app under `/jobs`. */
function TestApp() {
  return (
    <RouterProvider basePath="/jobs">
      <nav>
        <Link
          to="/"
          activeMatch="prefix"
        >
          Home
        </Link>
        <Link
          to="/queues"
          activeMatch="prefix"
        >
          Queues
        </Link>
        <Link to="/queues/a%2Fb">Queue a/b</Link>
      </nav>
      <ShowLocation />
      <Filter />
      <Routes
        routes={[
          { path: "/", element: <h1>Home page</h1> },
          { path: "/queues", element: <h1>Queue list</h1> },
          { path: "/queues/:queue", element: <ShowParams /> },
        ]}
        notFound={<h1>Not found</h1>}
      />
    </RouterProvider>
  );
}

describe("RouterProvider, Routes and Link", () => {
  it("renders the route for the current URL under basePath", () => {
    visit("/jobs/queues");
    render(<TestApp />);
    expect(page().getByRole("heading").textContent).toBe("Queue list");
  });

  it("renders the 404 for an unknown path and for a URL outside basePath", () => {
    visit("/jobs/nope");
    const first = render(<TestApp />);
    expect(page().getByRole("heading").textContent).toBe("Not found");
    first.unmount();
    visit("/elsewhere");
    render(<TestApp />);
    expect(page().getByRole("heading").textContent).toBe("Not found");
  });

  it("links carry the base in href, navigate in-app, and mark the current section", () => {
    visit("/jobs");
    render(<TestApp />);
    const queues = page().getByRole("link", { name: "Queues" });
    expect(queues.getAttribute("href")).toBe("/jobs/queues");
    expect(
      page().getByRole("link", { name: "Home" }).getAttribute("href"),
    ).toBe("/jobs");
    expect(
      page().getByRole("link", { name: "Home" }).getAttribute("aria-current"),
    ).toBe("page");

    fireEvent.click(queues);
    expect(window.location.pathname).toBe("/jobs/queues");
    expect(page().getByRole("heading").textContent).toBe("Queue list");
    expect(queues.getAttribute("aria-current")).toBe("page");
    expect(
      page().getByRole("link", { name: "Home" }).getAttribute("aria-current"),
    ).toBeNull();
  });

  it("binds params through useParams", () => {
    visit("/jobs");
    render(<TestApp />);
    fireEvent.click(page().getByRole("link", { name: "Queue a/b" }));
    expect(page().getByTestId("params").textContent).toBe('{"queue":"a/b"}');
    // The section link stays current on a sub-page.
    expect(
      page().getByRole("link", { name: "Queues" }).getAttribute("aria-current"),
    ).toBe("page");
  });

  it("leaves modified clicks to the browser, and handles plain ones itself", () => {
    visit("/jobs");
    render(<TestApp />);
    const link = page().getByRole("link", { name: "Queues" });
    // `fireEvent` returns false when the default action was prevented.
    const leftToBrowser = fireEvent.click(link, { ctrlKey: true });
    expect(leftToBrowser).toBe(true);
    expect(page().queryByText("Queue list")).toBeNull();
    visit("/jobs");
    const handled = fireEvent.click(link);
    expect(handled).toBe(false);
  });

  it("follows back/forward (popstate)", () => {
    visit("/jobs");
    render(<TestApp />);
    act(() => {
      window.history.pushState(null, "", "/jobs/queues");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(page().getByTestId("location").textContent).toBe("/queues");
  });

  it("keeps query-string state, replacing the history entry", () => {
    visit("/jobs/queues");
    render(<TestApp />);
    const length = window.history.length;
    fireEvent.change(page().getByLabelText("filter"), {
      target: { value: "mail" },
    });
    expect(window.location.search).toBe("?q=mail");
    expect(page().getByTestId("location").textContent).toBe("/queues?q=mail");
    expect(window.history.length).toBe(length);
    fireEvent.change(page().getByLabelText("filter"), {
      target: { value: "" },
    });
    expect(window.location.search).toBe("");
    expect(window.location.pathname).toBe("/jobs/queues");
  });

  it("reads query state from the URL it landed on", () => {
    visit("/jobs?q=rep");
    render(<TestApp />);
    expect((page().getByLabelText("filter") as HTMLInputElement).value).toBe(
      "rep",
    );
  });
});
