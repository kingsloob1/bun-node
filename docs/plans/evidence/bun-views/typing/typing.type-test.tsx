// Spike 8: what TypeScript can enforce about a handler's return value against
// a view's props, under experimentalDecorators (bun-nest's setting).
// Every `@ts-expect-error` is a negative control: if the line stops being an
// error, tsc fails with "Unused '@ts-expect-error' directive".
//
//   ../../../../../node_modules/.bin/tsc -p .   (from this folder; exit 0 = every claim holds)
import type { ComponentType } from "react";

// --- The shapes the plan proposes -------------------------------------------

/** Locals every view receives from app.locals / res.locals; augmented by the app. */
export interface ReactViewLocals {}
/** View name → props, for string views; augmented by the app (or generated). */
export interface ReactViews {}

type Awaitable<T> = T | Promise<T>;
/** What a handler must return for a view with props P: P minus the locals. */
type HandlerResult<P> = Awaitable<Omit<P, keyof ReactViewLocals>>;

/** @RenderComponent(Component): the handler must return the component's props. */
export function RenderComponent<P extends object>(component: ComponentType<P>) {
  return <T extends (...args: any[]) => HandlerResult<P>>(
    _target: object,
    _key: string | symbol,
    descriptor: TypedPropertyDescriptor<T>,
  ): void => {
    (Reflect as unknown as { defineMetadata: (k: string, v: unknown, t: unknown) => void }).defineMetadata("__renderTemplate__", component, descriptor.value);
  };
}
/** @RenderView("Name"): the string form, typed through the ReactViews registry. */
export function RenderView<K extends keyof ReactViews & string>(_name: K) {
  return <T extends (...args: any[]) => HandlerResult<ReactViews[K] & object>>(
    _target: object,
    _key: string | symbol,
    _descriptor: TypedPropertyDescriptor<T>,
  ): void => {};
}
/** A typed res.render over the same registry — naive: the untyped Express overload beside it. */
interface NaiveRender {
  render<K extends keyof ReactViews & string>(view: K, locals: Omit<ReactViews[K] & object, keyof ReactViewLocals>): void;
  render(view: string, locals?: object): void;
}
/** The fix: the untyped overload refuses a registered name. */
interface TypedRender {
  render<K extends keyof ReactViews & string>(view: K, locals: Omit<ReactViews[K] & object, keyof ReactViewLocals>): void;
  render<V extends string>(view: V extends keyof ReactViews ? never : V, locals?: object): void;
}

// --- An app ------------------------------------------------------------------

interface UserPageProps { user: { id: string; name: string }; appName: string }
function UserPage(props: UserPageProps) { return <h1>{props.user.name} @ {props.appName}</h1>; }

declare module "./typing.type-test" {
  interface ReactViewLocals { appName: string }
  interface ReactViews { UserPage: UserPageProps }
}

class Controller {
  @RenderComponent(UserPage)
  ok() { return { user: { id: "1", name: "Ada" } }; }

  @RenderComponent(UserPage)
  async okAsync() { return { user: { id: "1", name: "Ada" } }; }

  // @ts-expect-error a required prop is missing
  @RenderComponent(UserPage)
  missing() { return { } ; }

  // @ts-expect-error a prop has the wrong type
  @RenderComponent(UserPage)
  wrongType() { return { user: { id: 1, name: "Ada" } }; }

  @RenderView("UserPage")
  byName() { return { user: { id: "1", name: "Ada" } }; }

  // @ts-expect-error not a registered view name
  @RenderView("UsrPage")
  typo() { return {}; }

  // @ts-expect-error by name, a missing prop is caught too
  @RenderView("UserPage")
  byNameMissing() { return {}; }

  @RenderComponent(UserPage)
  extra() { return { user: { id: "1", name: "Ada" }, extra: true }; } // excess props are not caught (structural)

  @RenderComponent(UserPage)
  anyResult(): any { return 42; } // an `any` return disables the check
}

declare const naive: NaiveRender;
naive.render("UserPage", { user: { id: 1 } }); // NOT an error: wrong props fall through to the untyped overload

declare const res: TypedRender;
res.render("UserPage", { user: { id: "1", name: "Ada" } });
// @ts-expect-error typed res.render: wrong props
res.render("UserPage", { user: { id: 1 } });
res.render("legacy-ejs-view", { anything: 1 }); // an unregistered name still takes the untyped overload
declare const dynamic: string;
res.render(dynamic, {}); // a plain string is not narrowed, so it is accepted
void Controller;
