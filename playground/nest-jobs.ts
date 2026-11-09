/**
 * The playground's Nest app for bun-jobs (nest-jobs-decorators PR-n10), as an entry of its
 * own, on its own port: the playground itself is not a Nest app. Processors, schedules and
 * the pipeline, with the management API and the jobs UI on `BunJobsModule`'s context, behind
 * one guard.
 *
 * ```bash
 * bun playground/nest-jobs.ts                          # http://localhost:4002
 * PORT_NEST_JOBS=4003 bun playground/nest-jobs.ts      # another port
 * PLAYGROUND_INTERVAL_MS=0 bun playground/nest-jobs.ts # seed only, no new jobs
 * bun playground/nest-jobs-smoke.ts                    # checks all of this, then stops it
 * ```
 *
 * `index.ts` never imports this: the main playground stays Nest-free. Nothing here is on
 * disk, so it starts empty each time.
 */
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import type { BunJobs, BunQueue, Job } from "@kingsleyweb/bun-jobs";
import type { JobsUiAuthorizeContext } from "@kingsleyweb/bun-ui/jobs";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import {
  BUN_JOBS_API,
  BunJobsApiModule,
  BunJobsExecutionContext,
  BunJobsModule,
  CurrentJob,
  Cron,
  Every,
  getBunJobsToken,
  guardsAuthorize,
  InjectQueue,
  JobData,
  JobLoggingInterceptor,
  jobsApiContextOf,
  Process,
  Processor,
  UnrecoverableOn,
} from "@kingsleyweb/bun-nest/jobs";
import { jobsUi } from "@kingsleyweb/bun-ui/jobs";
import {
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Injectable,
  Module,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { ModuleRef, NestFactory, Reflector } from "@nestjs/core";
import "reflect-metadata";

/** What ran, for `/status`: a provider the handlers inject, so DI is what is being shown. */
@Injectable()
class Figures {
  /** Jobs that ran to the end, by name. */
  readonly completed: Record<string, number> = {};
  /** How often each schedule fired. */
  readonly ticks = { cron: 0, every: 0 };

  /** Counts a job that ran to the end. */
  done(name: string): void {
    this.completed[name] = (this.completed[name] ?? 0) + 1;
  }
}

/** A card refused by the bank: a filter makes it final, since a retry gets the same answer. */
class CardDeclined extends Error {
  override readonly name = "CardDeclined";
}

/** A job's guard: a refund needs its `approved`. */
@Injectable()
class ApprovedRefundsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const job = BunJobsExecutionContext.create(context).getJob();
    return (job.data as { approved?: boolean }).approved === true;
  }
}

@Processor("emails", { concurrency: 2 })
class EmailsProcessor {
  constructor(@Inject(Figures) private readonly figures: Figures) {}

  /** DI, a parameter decorator, an interceptor and the job's log. */
  @Process("welcome")
  @UseInterceptors(JobLoggingInterceptor)
  async welcome(@JobData("to") to: string, @CurrentJob() job: Job) {
    await job.log(`sending to ${to}`);
    this.figures.done("welcome");
    return `sent:${to}`;
  }
}

@Processor("payments")
class PaymentsProcessor {
  constructor(@Inject(Figures) private readonly figures: Figures) {}

  /** A pipe refuses `cents` that is not a number; a filter ends a declined card at once. */
  @Process("charge")
  @UseFilters(UnrecoverableOn(CardDeclined))
  charge(@JobData("cents", ParseIntPipe) cents: number) {
    if (cents > 100_000) {
      throw new CardDeclined(`${cents} is over the limit`);
    }
    this.figures.done("charge");
    return { charged: cents };
  }

  /** A guard denies a refund nobody approved: `dead` at once, whatever `attempts` says. */
  @Process("refund")
  @UseGuards(ApprovedRefundsGuard)
  refund(@JobData("cents") cents: number) {
    this.figures.done("refund");
    return { refunded: cents };
  }
}

/** The schedules: repeat jobs, not timers, so replicas would run each occurrence once. */
@Injectable()
class Schedules {
  constructor(@Inject(Figures) private readonly figures: Figures) {}

  /** Every second. */
  @Cron("* * * * * *")
  everySecond() {
    this.figures.ticks.cron++;
  }

  /** Every 1.5 s. */
  @Every(1_500)
  heartbeat() {
    this.figures.ticks.every++;
  }
}

const Roles = Reflector.createDecorator<string[]>();

/** Stands in for the API's routes: `read` for what changes nothing, `mutate` for what does. */
class JobsPolicy {
  @Roles(["reader", "admin"])
  read() {}

  @Roles(["admin"])
  mutate() {}
}

/**
 * Who may open the UI and call the API, over HTTP and on the socket: the `role` cookie
 * `/sign-in` sets, a pretend session. The UI's bundle is public: it holds no data.
 */
@Injectable()
class RoleGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (jobsApiContextOf<JobsUiAuthorizeContext>(context)?.asset === true) {
      return true;
    }
    const cookie = context
      .switchToHttp()
      .getRequest<BunRequest>()
      .getHeader("cookie");
    const role = /(?:^|;\s*)role=(\w+)/.exec(cookie ?? "")?.[1];
    if (role === undefined) {
      throw new UnauthorizedException("Sign in at /sign-in?role=reader");
    }
    return (this.reflector.get(Roles, context.getHandler()) ?? []).includes(
      role,
    );
  }
}

/** A dead job, as `/status` shows it. */
interface DeadJob {
  queue: string;
  name: string;
  attempts: number;
  error: string;
  message: string | undefined;
}

@Controller()
class PlaygroundController {
  constructor(
    @Inject(Figures) private readonly figures: Figures,
    @InjectQueue("emails") private readonly emails: BunQueue,
    @InjectQueue("payments") private readonly payments: BunQueue,
  ) {}

  /** What ran, and what the pipeline refused. */
  @Get("status")
  async status() {
    const dead: DeadJob[] = (
      await Promise.all(
        [this.emails, this.payments].map(async (queue) =>
          (await queue.list("dead")).map((job) => ({
            queue: queue.name,
            name: job.name,
            attempts: job.attemptsMade,
            error: job.failedReason?.name ?? "Error",
            message: job.failedReason?.message,
          })),
        ),
      )
    ).flat();
    return {
      completed: this.figures.completed,
      ticks: this.figures.ticks,
      dead,
    };
  }

  /** An order through HTTP: one email, one charge. */
  @Post("orders")
  async order(@Body() body: { to?: string; cents?: unknown }) {
    const email = await this.emails.add("welcome", {
      to: body.to ?? "someone@example.com",
    });
    const charge = await this.payments.add("charge", {
      cents: body.cents ?? 100,
    });
    return { email: email.id, charge: charge.id };
  }

  /** A pretend session, for the API's and the UI's guard. */
  @Get("sign-in")
  signIn(@Query("role") role: string | undefined, @Res() res: BunResponse) {
    res.setHeader(
      "set-cookie",
      `role=${role === "admin" ? "admin" : "reader"}; Path=/; SameSite=Lax`,
    );
    res.redirect("/");
  }

  /** Forgets it. */
  @Get("sign-out")
  signOut(@Res() res: BunResponse) {
    res.setHeader("set-cookie", "role=; Path=/; Max-Age=0; SameSite=Lax");
    res.redirect("/");
  }

  /** Where to start. */
  @Get()
  @Header("content-type", "text/html; charset=utf-8")
  page(@Req() req: BunRequest) {
    const role = /(?:^|;\s*)role=(\w+)/.exec(
      req.getHeader("cookie") ?? "",
    )?.[1];
    return `<!doctype html><meta charset="utf-8"><title>Nest jobs</title>
<h1>bun-jobs under Nest</h1>
<p>Signed in as: <b>${role === undefined ? "nobody" : role === "admin" ? "admin" : "reader"}</b>.
<a href="/sign-in?role=reader">reader</a> · <a href="/sign-in?role=admin">admin</a> · <a href="/sign-out">sign out</a></p>
<ul>
<li><a href="/jobs">/jobs</a>: the jobs UI, behind the guard. Dead jobs are under Queues.</li>
<li><a href="/jobs-api/queues">/jobs-api/queues</a>: the API, behind the same guard: 401 signed out; a reader reads, and a pause is 403.</li>
</ul>
<h2>What ran, refreshed each second</h2>
<pre id="status"></pre>
<script>
const show = async () => {
  const response = await fetch("/status");
  document.getElementById("status").textContent = JSON.stringify(await response.json(), null, 2);
};
show();
setInterval(show, 1000);
</script>`;
  }
}

@Module({
  imports: [
    BunJobsModule.forRoot({
      namespace: "playground-nest",
      driver: { type: "memory" },
      publishEvents: true,
      logger: false,
      shutdown: { timeout: 1_000 },
    }),
    BunJobsModule.registerQueue({ name: "emails" }),
    BunJobsModule.registerQueue({ name: "payments" }),
    // No `jobs`: it takes `BunJobsModule`'s context.
    BunJobsApiModule.forRootAsync({
      inject: [ModuleRef],
      useFactory: (moduleRef: ModuleRef) => ({
        basePath: "/jobs-api",
        logger: noopLogger,
        authorize: guardsAuthorize(moduleRef, [RoleGuard], {
          policy: JobsPolicy,
        }),
      }),
    }),
  ],
  controllers: [PlaygroundController],
  providers: [
    Figures,
    EmailsProcessor,
    PaymentsProcessor,
    ApprovedRefundsGuard,
    Schedules,
    RoleGuard,
  ],
})
class AppModule {}

/** One of everything the pipeline does. */
async function addOneOfEach(jobs: BunJobs): Promise<void> {
  const emails = jobs.queue("emails");
  const payments = jobs.queue("payments");
  await emails.add("welcome", { to: "ada@example.com" });
  await payments.add("charge", { cents: "1200" });
  await payments.add("charge", { cents: "not a number" });
  await payments.add("charge", { cents: 900_000 }, { attempts: 3 });
  await payments.add("refund", { cents: 500, approved: true });
  await payments.add("refund", { cents: 500 }, { attempts: 3 });
}

// Only when run directly: nothing imports this file.
if (import.meta.main) {
  /** The port (`PORT_NEST_JOBS`, default 4002: after the validated gateway's 4001). */
  const port = Number(process.env.PORT_NEST_JOBS ?? 4002);
  /** How often to add one of everything; `0` seeds once and stops. */
  const interval = Number(process.env.PLAYGROUND_INTERVAL_MS ?? 5_000);

  const adapter = new BunHttpAdapter();
  const app = await NestFactory.create(AppModule, adapter, { logger: false });
  app.useWebSocketAdapter(adapter.webSocketAdapter);
  const ui = jobsUi({
    api: app.get(BUN_JOBS_API),
    basePath: "/jobs",
    dev: true,
    authorize: guardsAuthorize(app.get(ModuleRef), [RoleGuard], {
      policy: JobsPolicy,
    }),
  });
  adapter.use(ui.basePath, ui.router);
  await app.listen(port, "127.0.0.1");

  const jobs = app.get<BunJobs>(getBunJobsToken());
  await addOneOfEach(jobs);
  const timer =
    interval > 0
      ? setInterval(() => {
          void addOneOfEach(jobs);
        }, interval)
      : undefined;

  const url = `http://localhost:${adapter.listeningPort}`;
  console.log(`
bun-node playground: bun-jobs under Nest

  Start    ${url}
  UI       ${url}/jobs       (sign in first: ${url}/sign-in?role=admin)
  API      ${url}/jobs-api
  Status   ${url}/status

  Ctrl+C to stop.
`);

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    clearInterval(timer);
    await app.close();
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => void shutdown());
  }
}
